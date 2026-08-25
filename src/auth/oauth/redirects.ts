/**
 * Which redirect URIs this server will send an authorization code to.
 *
 * Its own file because it is its own subject. `server.ts` is the flow as
 * decisions — a code exchanged, a token rotated, an owner approving — and none
 * of it is about URL shapes. Both halves stayed inside the file-size budget
 * until they did not, and the budget exists to point at exactly this: it was
 * not too long, it was two things.
 *
 * Nothing here consults configuration. What a client registered is checked
 * against what it now presents, and the rules are RFC 8252's rather than ours.
 */

/**
 * https, or loopback for a native client.
 *
 * A native client cannot receive an https redirect, so RFC 8252 has it listen
 * on a loopback port instead. Everything else is refused: a redirect to `http://`
 * on a routable host puts an authorization code on the wire in clear text.
 */
export function isSafeRedirect(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost';
}

/**
 * Exact match, except for the port of a loopback URI.
 *
 * RFC 8252 §7.3 requires ignoring the port for the IP-literal form, because a
 * native client binds an ephemeral one it cannot know at registration time.
 * Claude Code declares `http://localhost/callback` and `http://127.0.0.1/callback`
 * and then listens on whatever port it got, so the same allowance has to cover
 * `localhost` or it never connects.
 */
export function matchesRegistered(candidate: string, registered: readonly string[]): boolean {
  if (registered.includes(candidate)) return true;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (!isLoopbackHost(parsed.hostname)) return false;

  return registered.some((uri) => {
    try {
      const other = new URL(uri);
      return (
        isLoopbackHost(other.hostname) &&
        other.protocol === parsed.protocol &&
        other.hostname === parsed.hostname &&
        other.pathname === parsed.pathname
      );
    } catch {
      return false;
    }
  });
}
