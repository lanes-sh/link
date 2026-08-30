import { isHandle } from '#connectivity/mail';
import { mergeCapabilities, type ProfileRuntime } from './mcp/index.ts';
import type { Principal } from '#auth';

/**
 * Handing the endpoint some bytes, so a later call can name them.
 *
 * The one thing the protocol cannot do. A tool argument carries JSON, so a file
 * in a tool call is base64 in the model's output — which for a 239 KB PDF is
 * around 320,000 characters, past what a model can write in one message. There is
 * no client-to-server binary channel in any released version of MCP, and `roots`
 * never carried bytes even before it was deprecated. So the bytes come in over
 * ordinary HTTP, out of band, and what travels through the model afterwards is a
 * handle. That is also the shape the protocol's own draft file-transfer work
 * settles on.
 *
 * This is what makes attachments work when the endpoint is not on the caller's
 * machine. A `path` names the filesystem the *server* can see, which on a hosted
 * deployment is a container and not the operator's Mac; a handle does not care
 * where either end is.
 *
 * **Staged for one connection, not for the profile.** A blob store handed to a
 * provider is already namespaced by provider and connection, and the point of
 * that is that one account's bytes are not reachable from another. Staging into a
 * shared area would quietly widen it. So an upload names its target, the
 * principal has to be able to reach that target, and the handle resolves only
 * from there.
 *
 * This file does HTTP and authorization; the write itself is
 * `Dispatcher.stageAttachment`. Not a split for its own sake — `server` may not
 * reach a store, and should not: how blobs are namespaced is not something a
 * component that speaks HTTP should know, and putting the write behind the
 * dispatcher is also what gets it into the audit log.
 */

export const ATTACHMENTS_PATH = '/attachments';

/**
 * Largest upload accepted.
 *
 * Above every mail host's own ceiling — 35 MiB is the largest here — so this is
 * never the binding limit on a legitimate send, and well under Bun's 128 MiB
 * default body cap so a refusal is ours and legible rather than the runtime's.
 */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export interface StageOptions {
  readonly profiles: ReadonlyMap<string, ProfileRuntime>;
  readonly primary: string;
  readonly principal: Principal;
  readonly request: Request;
  readonly clientLabel?: string | undefined;
}

/**
 * One path, both directions.
 *
 * `POST` takes bytes and gives back a handle; `GET` takes a handle and gives
 * back the bytes. Same path, same query, same authorization, because they are
 * the two ends of one idea and splitting them across two routes would invite
 * the scoping to drift apart — which is the one thing that must not happen
 * here, since the scoping is what keeps one account's files out of another's.
 */
export async function handleAttachments(options: StageOptions): Promise<Response> {
  const { request } = options;

  if (request.method !== 'POST' && request.method !== 'GET') {
    return problem(405, 'Stage an attachment with POST, or fetch one with GET.');
  }

  const url = new URL(request.url);
  const profileName = url.searchParams.get('profile') ?? options.primary;
  const target = url.searchParams.get('connection');

  if (!target) {
    return problem(
      400,
      'Name the connection this is for, as ?connection=<provider>.<account> — a staged file belongs to one account, not to the endpoint.',
    );
  }

  const runtime = options.profiles.get(profileName);
  if (!runtime) {
    return problem(404, `No profile "${profileName}" on this endpoint.`);
  }

  const [providerId, ...rest] = target.split('.');
  const connectionId = rest.join('.');
  if (!providerId || !connectionId) {
    return problem(400, `"${target}" is not a connection. Use <provider>.<account>.`);
  }

  // The same policy that decides which connections a tool may name. Staging into
  // an account the caller cannot act on would be a write they are not permitted
  // to make, even though nothing is sent by it — and fetching back out of one is
  // a read they are not permitted to make, which matters more.
  if (!reachable(runtime, options, profileName, target)) {
    return problem(
      403,
      `Connection "${target}" is not reachable for this token in profile "${profileName}".`,
    );
  }

  if (request.method === 'GET') {
    return await fetchAttachment({ options, runtime, url, providerId, connectionId, target });
  }

  const bytes = await readCapped(request);
  if (!bytes) {
    return problem(413, `An attachment must be smaller than ${MAX_UPLOAD_BYTES} bytes.`);
  }
  if (bytes.byteLength === 0) {
    return problem(400, 'The request body was empty, so there is nothing to stage.');
  }

  const filename = filenameFrom(request.headers.get('x-filename'));
  const contentType = request.headers.get('content-type') ?? 'application/octet-stream';

  const staged = await runtime.dispatcher.stageAttachment({
    principal: options.principal,
    providerId,
    connectionId,
    bytes,
    filename,
    contentType,
    clientLabel: options.clientLabel,
  });

  return Response.json({
    handle: staged.handle,
    filename,
    bytes: bytes.byteLength,
    content_type: contentType,
    sha256: staged.sha256,
    expires_at: new Date(staged.expiresAt).toISOString(),
    connection: target,
    profile: profileName,
    hint: `Pass it as an attachment: { "handle": "${staged.handle}" }`,
  });
}

/**
 * Handing a staged file back.
 *
 * The counterpart to the upload, and the thing that makes an attachment which
 * arrived by mail reachable at all: `get_attachment` on a mail connection pulls
 * the bytes out of the mailbox and stages them *in that same connection's*
 * namespace, and this is where the client collects them. No provider gains
 * reach it did not have — the bytes were already inside that account's area —
 * and nothing crosses between two connections.
 *
 * The bytes go out over HTTP for the same reason they come in that way: a file
 * in a tool result is base64 in the model's context, which for a 239 KB PDF is
 * around 320,000 characters of something no model needs to read.
 */
async function fetchAttachment(input: {
  readonly options: StageOptions;
  readonly runtime: ProfileRuntime;
  readonly url: URL;
  readonly providerId: string;
  readonly connectionId: string;
  readonly target: string;
}): Promise<Response> {
  const handle = input.url.searchParams.get('handle');
  if (!handle) {
    return problem(400, 'Name the file to fetch, as ?handle=att_… — the handle a stage or a get_attachment returned.');
  }
  if (!isHandle(handle)) {
    return problem(400, `"${handle}" is not a handle.`);
  }

  const found = await input.runtime.dispatcher.fetchStagedAttachment({
    principal: input.options.principal,
    providerId: input.providerId,
    connectionId: input.connectionId,
    handle,
    clientLabel: input.options.clientLabel,
  });

  // One answer for absent, expired, and staged-against-another-connection. The
  // caller can act on none of the three differently, and telling them apart is
  // how someone probes for handles belonging to an account they cannot reach.
  if (!found) {
    return problem(
      404,
      `No staged file "${handle}" for ${input.target}. A staged file lasts 24 hours and belongs to the connection it was staged for.`,
    );
  }

  return new Response(found.bytes, {
    headers: {
      'content-type': found.contentType ?? 'application/octet-stream',
      'content-length': String(found.bytes.byteLength),
      // `attachment` rather than `inline`: this is a file the caller asked for,
      // and a browser rendering someone's mail attachment in the tab is not it.
      'content-disposition': dispositionFor(found.filename),
      // Handles are unguessable and short-lived, but a shared cache holding
      // somebody's mail attachment is not a trade worth making.
      'cache-control': 'no-store',
    },
  });
}

/**
 * A `Content-Disposition` that survives a non-ASCII filename.
 *
 * RFC 6266: the bare `filename` is the fallback for old clients and must stay
 * ASCII, and `filename*` carries the real one percent-encoded. Mail attachments
 * are exactly where this bites — an invoice from a German sender is called
 * `Rechnung_Kaufmännisch.pdf` and a raw header would be rejected outright.
 */
function dispositionFor(filename: string | null): string {
  if (!filename) return 'attachment';

  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Whether this principal can reach that connection for anything at all. */
function reachable(
  runtime: ProfileRuntime,
  options: StageOptions,
  profileName: string,
  target: string,
): boolean {
  const merged = mergeCapabilities({
    profiles: new Map([[profileName, runtime]]),
    principal: options.principal,
  });

  for (const capability of merged.values()) {
    for (const connections of capability.reachable.values()) {
      if (connections.includes(target)) return true;
    }
  }

  return false;
}

/**
 * Read the body, refusing past the cap.
 *
 * Streamed rather than buffered-then-measured, so an oversized upload costs the
 * bytes it takes to notice rather than all of them.
 */
async function readCapped(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return null;

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * A filename safe to record and to put in a MIME header.
 *
 * Basename only, and no traversal: the value is echoed into a
 * `Content-Disposition` and stored beside the bytes, and neither wants a path.
 */
function filenameFrom(header: string | null): string {
  const candidate = decodeHeader(header ?? '').split(/[/\\]/).pop()?.trim() ?? '';
  return candidate === '' || candidate === '.' || candidate === '..' ? 'attachment' : candidate;
}

/**
 * A header value as the bytes it actually was.
 *
 * An HTTP header carries bytes, and a runtime hands them back one character per
 * byte — so a filename a client sent as UTF-8 arrives here as mojibake and is
 * *stored* that way. `Rechnung_Kaufmännisch.pdf` became
 * `Rechnung_KaufmÃ¤nnisch.pdf` in the metadata sidecar, and stayed wrong on the
 * way back out; it was invisible while there was no way to fetch a file back.
 *
 * Pure ASCII is returned untouched, which is almost every filename. Anything
 * that is not valid UTF-8 keeps whatever it was rather than being replaced with
 * question marks — a name we cannot decode is still the name the client chose.
 */
function decodeHeader(value: string): string {
  // Nothing to do for ASCII, and a code point above 0xff means the runtime has
  // already decoded it — reinterpreting that would be the corruption, not the fix.
  let latin1 = false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0xff) return value;
    if (code > 0x7f) latin1 = true;
  }
  if (!latin1) return value;

  try {
    const bytes = Uint8Array.from(value, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
