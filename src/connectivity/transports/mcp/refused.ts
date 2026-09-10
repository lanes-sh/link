import { UnauthorizedError } from '@modelcontextprotocol/client';

/**
 * A credential the upstream server refused, told to the layer that caches it.
 *
 * This transport had no way to say it. The `http` one reads `response.status`;
 * here the reply is consumed by a client library that turns a 401 into an
 * exception, so there was no status for anything to check — and a refused token
 * went on being sent until its stored clock ran out. That is the failure the
 * distrust path exists to end, left in place on the largest share of the
 * estate: 77 of roughly 105 providers declare `connector.kind: 'mcp'`.
 *
 * `UnauthorizedError` is the library's own answer, and it is brand-based, so it
 * survives two copies of the package in one process. Matching on the message
 * text was the alternative, and that is a guess.
 *
 * A `Response` is synthesised because it is the shared vocabulary for "the
 * vendor said no", not because one was received. The retry the verifier offers
 * is dropped: this connector opens a client, calls, and closes it, so honouring
 * a retry means running all of that again. Worth doing, and a larger change
 * than telling the truth about the token.
 *
 * Its own file because `index.ts` is four lines under the budget and this is a
 * subject rather than a line — the same reason `expand.ts` sits beside the
 * gateway that uses it.
 */
export async function distrustIfRefused(
  verify: ((response: Response) => Promise<unknown>) | undefined,
  error: unknown,
): Promise<void> {
  if (verify && error instanceof UnauthorizedError) {
    await verify(new Response(null, { status: 401 }));
  }
}
