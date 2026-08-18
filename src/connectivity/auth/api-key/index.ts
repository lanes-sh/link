import type { ResolvedCredential } from '../credential.ts';

/**
 * A key in a header, or — where a vendor insists — in the query string.
 *
 * `query` had been in the schema since M2 and was never read, so an
 * api-key-in-query manifest sent an unauthenticated request and got a 401
 * naming nothing.
 */
export function resolveApiKey(
  value: string,
  options: { header?: string | undefined; query?: string | undefined },
): ResolvedCredential {
  return {
    kind: 'api_key',
    value,
    ...(options.query ? { query: options.query } : { header: options.header ?? 'x-api-key' }),
  };
}

/**
 * Returns a replacement request when the key belongs in the URL.
 *
 * A Request's URL is immutable, so moving the key into the query means
 * rebuilding rather than mutating. Passing the Request itself as the init
 * carries method, headers, and body verbatim; the cast is only because
 * TypeScript types the init as `RequestInit`, whose `body` is narrower than the
 * `ReadableStream` a built Request holds.
 */
export function attachApiKey(
  credential: Extract<ResolvedCredential, { kind: 'api_key' }>,
  request: Request,
  original: Request,
): Request | undefined {
  if (!credential.query) {
    request.headers.set(credential.header ?? 'x-api-key', credential.value);
    return undefined;
  }

  const relocated = new URL(original.url);
  relocated.searchParams.set(credential.query, credential.value);
  return new Request(relocated.href, request as unknown as RequestInit);
}
