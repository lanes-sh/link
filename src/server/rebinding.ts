import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  originValidationResponse,
} from '@modelcontextprotocol/server';

/**
 * DNS-rebinding protection for a loopback endpoint.
 *
 * The attack this exists for needs no bug to work. An endpoint on 127.0.0.1 is
 * reachable by any page the owner happens to be visiting: the attacker serves a
 * short-TTL record, rebinds it to loopback, and the browser then calls this
 * endpoint same-origin — at which point CORS stops applying and responses
 * become readable. What it reaches is everything that answers before
 * authentication, which is `/health`, the discovery documents, `/register`, and
 * the `/authorize` consent form that asks for the owner's token.
 *
 * The check belongs here rather than in the MCP handler because the SDK's entry
 * is documented as deliberately validation-free and expects this in front of
 * it. The helpers are the SDK's for the same reason `quoted` is one function: a
 * second implementation of a check is a second thing to drift.
 *
 * Only for loopback. A routable deployment gets nothing from this — rebinding
 * to a public address buys an attacker no reach the address did not already
 * give — and its hostname is assigned by the platform rather than known here,
 * so a fixed allowlist would refuse every legitimate request instead.
 */
export function allowedHostnamesFor(host: string, isLoopbackHost: boolean): string[] | undefined {
  if (!isLoopbackHost) return undefined;

  // The SDK's list rather than our own `LOOPBACK` set: this one has to match
  // what a *browser* puts in a Host header, which means `[::1]` in brackets and
  // every `*.localhost` name, not just the three spellings we bind to.
  const allowed = localhostAllowedHostnames();
  return allowed.includes(host) ? allowed : [...allowed, host];
}

/**
 * The refusal, or `undefined` to let the request through.
 *
 * Host and Origin answer different questions — where the request thinks it is
 * going, and where it came from — so both are checked. A missing Origin passes
 * by design: no non-browser client sends one, and every MCP client is one.
 */
export function rebindingRefusal(
  request: Request,
  allowedHostnames: readonly string[],
): Response | undefined {
  const allowed = [...allowedHostnames];
  return (
    hostHeaderValidationResponse(request, allowed) ?? originValidationResponse(request, allowed)
  );
}
