import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Fetching bytes from a URL a caller named, without becoming an SSRF gadget.
 *
 * This is the one attachment source that adds an attack surface rather than just
 * a capability, and the threat model is concrete rather than theoretical: an
 * agent reads a hostile email, the email says "attach the file at this URL", and
 * the endpoint obliges. Deployed on Cloud Run the interesting target is one hop
 * away — `169.254.169.254` hands out the service account token to anything that
 * asks it.
 *
 * Four rules, in order of how much they buy:
 *
 *   1. HTTPS only. Plaintext to a named host is not a use case worth the hole.
 *   2. Resolve the hostname and check **every** address it answers with, not the
 *      first. A name with one public and one private A record would otherwise
 *      pass a check and then connect wherever the OS felt like.
 *   3. Do not follow redirects implicitly. Each hop is a fresh URL that has to
 *      pass the same checks, because a public host redirecting to `127.0.0.1` is
 *      the standard bypass.
 *   4. Cap the body while reading it, not by trusting `Content-Length`.
 *
 * What this deliberately does not do is parse IP literals by hand. MCP's own
 * security guidance is blunt that custom parsers miss octal, hex and
 * IPv4-mapped-IPv6 encodings, so the only IPs classified here are ones `isIP`
 * has already accepted as canonical or `dns.lookup` produced — an octal literal
 * like `0177.0.0.1` is not a valid address, so it falls through to name
 * resolution and fails there.
 *
 * Known residual risk: a name could resolve to a safe address during the check
 * and a hostile one during the connection. Closing that needs the connection
 * pinned to the address we validated, which means owning the socket — `fetch`
 * does not expose it, and rewriting the URL to the literal IP would break TLS
 * verification, trading a narrow race for a broken one. Recorded rather than
 * hidden.
 */

const MAX_REDIRECTS = 3;

export interface FetchedFile {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  readonly filename: string | null;
}

export type AddressLookup = (hostname: string) => Promise<readonly string[]>;

const resolveAddresses: AddressLookup = async (hostname) => {
  if (isIP(hostname) !== 0) return [hostname];
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

export async function fetchFromUrl(input: {
  readonly url: string;
  readonly maxBytes: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly addresses?: AddressLookup;
  readonly signal?: AbortSignal | undefined;
}): Promise<FetchedFile> {
  const doFetch = input.fetch ?? globalThis.fetch;
  const addresses = input.addresses ?? resolveAddresses;

  let target = await checkedUrl(input.url, addresses);

  for (let hop = 0; ; hop += 1) {
    const response = await doFetch(target.href, {
      redirect: 'manual',
      headers: { accept: '*/*' },
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`${target.href} redirected without a Location header.`);
      if (hop >= MAX_REDIRECTS) {
        throw new Error(`${input.url} redirected more than ${MAX_REDIRECTS} times.`);
      }
      // Resolved against the current URL so a relative Location works, then
      // checked from scratch: a hop is a new destination, not a continuation.
      target = await checkedUrl(new URL(location, target).href, addresses);
      continue;
    }

    if (!response.ok) {
      throw new Error(`${target.href} answered ${response.status} ${response.statusText}.`);
    }

    return {
      bytes: await readCapped(response, input.maxBytes, target.href),
      contentType: normalizeContentType(response.headers.get('content-type')),
      filename: filenameFromDisposition(response.headers.get('content-disposition')),
    };
  }
}

/** Parse, require HTTPS, and refuse a host that resolves anywhere internal. */
async function checkedUrl(candidate: string, addresses: AddressLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`"${candidate}" is not a URL.`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(
      `Attachment URLs must be https — "${url.protocol}//" is not fetched. Stage the file instead if it is not reachable over HTTPS.`,
    );
  }

  let resolved: readonly string[];
  try {
    resolved = await addresses(url.hostname);
  } catch {
    throw new Error(`${url.hostname} does not resolve.`);
  }

  if (resolved.length === 0) throw new Error(`${url.hostname} does not resolve.`);

  for (const address of resolved) {
    if (isBlocked(address)) {
      throw new Error(
        `${url.hostname} resolves to ${address}, which is a private, loopback, or link-local address. Refusing to fetch it.`,
      );
    }
  }

  return url;
}

/**
 * Is this address one we must never connect to on a caller's behalf?
 *
 * Covers the ranges RFC 9728 §7.7 names, plus multicast and reserved space. The
 * IPv4-mapped and NAT64 cases unwrap and re-check, because `::ffff:127.0.0.1` is
 * loopback wearing a different spelling.
 */
export function isBlocked(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedV4(address);
  if (version === 6) return isBlockedV6(address);
  // Not an address at all. Treated as blocked because every caller here has
  // already resolved a name, so an unparseable value means something upstream
  // is wrong and connecting anyway is the worse failure.
  return true;
}

function isBlockedV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [a = 0, b = 0] = parts;

  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast

  return false;
}

function isBlockedV6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;

  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) both carry a v4
  // address in the last four bytes. Judge them as what they actually reach.
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  if (mapped || nat64) {
    return isBlockedV4(bytes.slice(12).join('.'));
  }

  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true; // ::1
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xff) return true; // ff00::/8 multicast

  return false;
}

/**
 * Expand an IPv6 address to its sixteen bytes.
 *
 * Only ever called with a string `isIP` accepted, so the shape is already
 * canonical — this handles `::` compression and a trailing dotted-quad, and
 * returns null rather than guessing on anything else.
 */
function ipv6Bytes(address: string): number[] | null {
  let text = address;

  // A trailing IPv4 form (::ffff:127.0.0.1) becomes two more hextets.
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[1]!.split('.').map(Number);
    if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, dotted.index)}${high}:${low}`;
  }

  const [head, tail, ...extra] = text.split('::');
  if (extra.length > 0) return null;

  const parse = (group: string | undefined): number[] => {
    if (!group) return [];
    return group.split(':').flatMap((hextet) => {
      const value = Number.parseInt(hextet, 16);
      return [(value >> 8) & 0xff, value & 0xff];
    });
  };

  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  const gap = 16 - front.length - back.length;
  if (gap < 0) return null;
  if (tail === undefined && gap !== 0) return null;

  return [...front, ...Array<number>(gap).fill(0), ...back];
}

/**
 * Read the body, stopping at the cap.
 *
 * Streamed rather than `arrayBuffer()` because `Content-Length` is the server's
 * claim about the server's own body — a hostile or broken one can understate it,
 * and buffering first to measure second is how a size limit becomes a memory
 * limit instead.
 */
async function readCapped(response: Response, maxBytes: number, href: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${href} is ${declared} bytes, over the ${maxBytes} byte limit.`);
  }

  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`${href} is larger than the ${maxBytes} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizeContentType(header: string | null): string | null {
  if (!header) return null;
  const value = header.split(';')[0]?.trim().toLowerCase();
  return value ? value : null;
}

/** `attachment; filename="report.pdf"`, and the RFC 5987 `filename*` form. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;

  const extended = header.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }

  const plain = header.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
  const value = plain?.[2] ?? plain?.[1];
  return value ? value.trim() : null;
}
