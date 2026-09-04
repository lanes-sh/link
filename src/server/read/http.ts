/**
 * The three answers `/state`, `/audit` and `/data` all have to give the same way.
 *
 * Extracted when the data surface arrived, because that surface allows methods
 * the other two refuse and the CORS headers had to become an argument. Two
 * copies of `cors` would be two answers to what a pairing token's origin may
 * do, and the one that drifted would be the one nobody was reading.
 *
 * Everything ADR-063 fixes about these headers is fixed here: one named origin
 * echoed rather than wildcarded, `Vary: Origin` unconditionally including on a
 * refusal, a fixed header list rather than a reflected one, and no
 * `access-control-allow-credentials` at all.
 */

export function bearer(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;

  const presented = header.slice(7).trim();
  return presented === '' ? null : presented;
}

/**
 * The CORS headers for one surface.
 *
 * `methods` and `headers` are named by the caller rather than reflected from
 * the request. Echoing `Access-Control-Request-Headers` would grant whatever
 * was asked for, which is ADR-039's rule and the reason the read surface has
 * never done it — and it matters more now that one of these lists contains
 * `PUT` and `DELETE`.
 */
export function cors(
  origin: string | null,
  allowed: boolean,
  methods: string,
  headers = 'authorization',
): Record<string, string> {
  // `Vary: Origin` unconditionally, including on a refusal. Without it a cache
  // between here and the page can serve one origin's answer to another, which
  // is the whole grant leaking through an intermediary.
  const out: Record<string, string> = { vary: 'Origin' };
  if (!allowed || origin === null) return out;

  out['access-control-allow-origin'] = origin;
  out['access-control-allow-headers'] = headers;
  out['access-control-allow-methods'] = methods;
  out['access-control-max-age'] = '600';
  // Deliberately absent: `access-control-allow-credentials`. The token is sent
  // explicitly by the page, so allowing cookies would add an ambient credential
  // to a surface whose safety rests on there not being one.
  return out;
}

export function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
