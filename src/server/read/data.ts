import { isDataStore, type Answer, type DataStoreName, type DataSurface } from '#cli/owner-data/surface.ts';
import { json } from './http.ts';

/**
 * The owner's own data, over the pairing credential (ADR-069).
 *
 * A sibling of `./routes.ts` rather than a branch inside it, and it shares that
 * file's gate rather than repeating it: `readRoutes` checks the origin and the
 * credential once and hands over what `isDataPath` matched. So there is exactly
 * one place a pairing token is verified, which is what stops the two surfaces
 * disagreeing about who may reach them.
 *
 * **This knows no store's shape.** Every answer below is a projection of what
 * `DataSurface` returned, and that interface is satisfied under `cli`, which is
 * the only component allowed to reach both a store and the log. `server` may
 * import neither, and this file widens nothing to get around that — the same
 * arrangement `readRoutes` already keeps with `AuditTail`.
 *
 * **Methods are the whole of what changed.** `/state` and `/audit` still answer
 * `404` to anything that is not a `GET`, and they still do it here.
 */

const DATA_PREFIX = '/data';

/** The methods this surface answers. Everything else is a `404`, as elsewhere. */
export const DATA_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

/**
 * `content-type` joins the allowed headers, because a body-carrying request is
 * no longer simple and preflights on it. Named rather than reflected.
 */
export const DATA_HEADERS = 'authorization, content-type';

export function isDataPath(pathname: string): boolean {
  return pathname === DATA_PREFIX || pathname.startsWith(`${DATA_PREFIX}/`);
}

/** The most a listing returns, whatever was asked for. `/audit`'s ceiling. */
const LIMIT_CEILING = 500;

interface Route {
  readonly store: DataStoreName;
  readonly id: string | null;
  /** `/data/assets/<name>/content`, the one route that answers bytes. */
  readonly content: boolean;
}

/**
 * The path, or `null` for anything that is not one of the five shapes.
 *
 * Rejected rather than repaired: a segment that is not a store on the closed
 * list, an empty id, or a trailing segment other than `content` is not a path
 * this surface has, and answering one would be inventing a route.
 */
function parse(pathname: string): Route | null {
  const parts = pathname.slice(DATA_PREFIX.length).split('/').filter((one) => one.length > 0);
  const [store, id, tail, ...rest] = parts;

  if (store === undefined || !isDataStore(store) || rest.length > 0) return null;
  if (id === undefined) return { store, id: null, content: false };

  const name = safeDecode(id);
  if (name === null || name.length === 0) return null;

  if (tail === undefined) return { store, id: name, content: false };
  if (tail === 'content' && store === 'assets') return { store, id: name, content: true };
  return null;
}

/** A percent-encoded segment, or `null` where it will not decode. */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export async function dataRoutes(
  request: Request,
  url: URL,
  surface: DataSurface,
  headers: Record<string, string>,
): Promise<Response> {
  const route = parse(url.pathname);
  const profile = url.searchParams.get('profile');

  // Not found rather than a message naming what was wrong. An unknown store, a
  // malformed path and a profile this endpoint does not serve are one answer,
  // so none of them tells a page that is not the dashboard what does exist.
  if (route === null || profile === null || profile === '') {
    return json({ error: 'not_found' }, 404, headers);
  }

  if (route.content && route.id !== null) {
    if (request.method !== 'GET') return json({ error: 'not_found' }, 404, headers);
    return content(await surface.content({ profile, name: route.id }), headers);
  }

  const scope = { profile, store: route.store };

  switch (request.method) {
    case 'GET':
      return route.id === null
        ? answer(
            await surface.list({
              ...scope,
              query: url.searchParams.get('query') ?? undefined,
              limit: limitOf(url),
            }),
            headers,
            (items) => ({ store: route.store, profile, items }),
          )
        : answer(await surface.read({ ...scope, id: route.id }), headers, (item) => item);

    case 'POST': {
      if (route.id !== null) return json({ error: 'not_found' }, 404, headers);
      const body = await documentOf(request);
      if (body === null) return json({ error: 'bad_request' }, 400, headers);
      return answer(await surface.create({ ...scope, body }), headers, (item) => item);
    }

    case 'PUT': {
      if (route.id === null) return json({ error: 'not_found' }, 404, headers);
      const body = await documentOf(request);
      if (body === null) return json({ error: 'bad_request' }, 400, headers);
      return answer(await surface.write({ ...scope, id: route.id, body }), headers, (item) => item);
    }

    case 'DELETE': {
      if (route.id === null) return json({ error: 'not_found' }, 404, headers);
      return answer(await surface.remove({ ...scope, id: route.id }), headers, () => ({
        id: route.id,
        deleted: true,
      }));
    }

    default:
      return json({ error: 'not_found' }, 404, headers);
  }
}

function limitOf(url: URL): number | undefined {
  const raw = Number(url.searchParams.get('limit'));
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(raw, LIMIT_CEILING);
}

/** The `body` out of a JSON request, or `null` for anything that is not one. */
async function documentOf(request: Request): Promise<string | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null) return null;
    const body = (parsed as { body?: unknown }).body;
    return typeof body === 'string' ? body : null;
  } catch {
    return null;
  }
}

/**
 * One answer, or the refusal the surface decided on.
 *
 * The status comes from the surface rather than being inferred here, because
 * only it knows the difference between an item that is absent, a store this
 * profile does not grant, and a document the store would not accept. The
 * message travels for `400` alone: the others are the same body an unknown
 * path gets, deliberately.
 */
function answer<T>(
  result: Answer<T>,
  headers: Record<string, string>,
  shape: (value: T) => unknown,
): Response {
  if (result.ok) return json(shape(result.value), 200, headers);

  const { status, error, message } = result.refusal;
  return json(status === 400 ? { error, message } : { error }, status, headers);
}

/**
 * An asset's bytes, with the type they were stored under.
 *
 * `attachment` and `nosniff`, always. On a deployed bind this origin also
 * serves `/mcp`, `/authorize` and the discovery documents, so a stored
 * `text/html` asset served inline would run script in the endpoint's own
 * origin. A page fetches this and makes an object URL, which `attachment` does
 * not obstruct.
 */
function content(result: Answer<{ bytes: Uint8Array; contentType: string }>, headers: Record<string, string>): Response {
  if (!result.ok) return json({ error: result.refusal.error }, result.refusal.status, headers);

  // Copied into a fresh view before it is handed to `Response`, so the body is
  // a buffer of its own rather than a window onto whatever the adapter returned.
  const bytes = new Uint8Array(result.value.bytes);

  return new Response(bytes.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      ...headers,
      'content-type': result.value.contentType,
      'content-length': String(bytes.byteLength),
      'content-disposition': 'attachment',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
