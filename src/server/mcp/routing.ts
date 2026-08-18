import { isResource } from '#connectivity';
import type { MergedCapability, ProfileRuntime } from './visibility.ts';

/**
 * Getting the profile and the connection into an address.
 *
 * A tool takes them as injected arguments (ADR-001). A resource has no argument
 * to route on, so they go into the URI; a prompt has arguments but is typically
 * filled in by a person choosing a slash command, so they are optional there and
 * default when there is only one candidate.
 */

/**
 * Put the profile and the connection into a resource URI.
 *
 * They have to go somewhere that works for *any* template, not just one that
 * happens to spell `{key}`, so they are inserted as the first two path segments
 * directly after the authority: `example://note/{key}` becomes
 * `example://note/personal/a/{key}`, and `memory://entry/{id}` becomes
 * `memory://entry/personal/owner/{id}`.
 *
 * The previous form substituted the literal token `{key}`, which meant any
 * provider naming its variable anything else — every provider except `example` —
 * registered a URI with no routing in it at all, and two connections would have
 * collided on one address.
 */
export function scopeResourceUri(
  uriOrTemplate: string,
  scope: { profile: string; connectionId: string },
): string {
  const separator = uriOrTemplate.indexOf('://');
  if (separator === -1) return uriOrTemplate;

  const scheme = uriOrTemplate.slice(0, separator + 3);
  const rest = uriOrTemplate.slice(separator + 3);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);

  return `${scheme}${authority}/${scope.profile}/${scope.connectionId}${path}`;
}

/** `scheme://authority`, or empty for anything not shaped like that. */
function originOf(uri: string): string {
  const separator = uri.indexOf('://');
  if (separator === -1) return '';

  const rest = uri.slice(separator + 3);
  const slash = rest.indexOf('/');
  return uri.slice(0, separator + 3) + (slash === -1 ? rest : rest.slice(0, slash));
}

/**
 * Route the `resource_link`s a tool hands back.
 *
 * A provider names its own resources — `memory://entry/deploy_window` — because
 * it does not know, and must not learn, which profile or connection it is
 * serving. Core does. Without this, `memory.search` returns addresses that look
 * like resources and cannot be read, which is worse than returning none.
 *
 * Scoped **only** for a link whose scheme and authority match one of this
 * provider's own resource templates. A link to somewhere else — an `https://`
 * document a vendor returned — is left exactly as the vendor wrote it; inserting
 * routing segments into someone else's URL would corrupt it.
 */
export function resourceLinkRouter(
  runtime: ProfileRuntime,
  capabilityId: string,
  profile: string,
  connectionKey: string,
): (uri: string) => string {
  const providerId = capabilityId.slice(0, capabilityId.indexOf('.'));
  const definition = runtime.registry.get(providerId)?.definition;
  if (!definition) return (uri) => uri;

  const origins = new Set(
    definition.capabilities
      .filter(isResource)
      .map((capability) => originOf(capability.uriTemplate)),
  );
  if (origins.size === 0) return (uri) => uri;

  const connectionId = connectionKey.slice(connectionKey.indexOf('.') + 1);

  return (uri) =>
    origins.has(originOf(uri)) ? scopeResourceUri(uri, { profile, connectionId }) : uri;
}

/**
 * Which profile and connection a prompt call meant.
 *
 * Same refusal a tool gets when a profile and a connection belong to different
 * profiles, for the same reason: the enums are a union, and routing a `work`
 * account through `personal` would cross exactly the boundary profiles exist to
 * hold.
 */
export function resolveScope(
  entry: MergedCapability,
  profile: unknown,
  connection: unknown,
): { profile: string; connectionKey: string } | { error: string } {
  const profiles = [...entry.reachable.keys()];
  const name = typeof profile === 'string' ? profile : (profiles.length === 1 ? profiles[0]! : '');

  const reachable = entry.reachable.get(name);
  if (!reachable) {
    return { error: `Name a profile: ${profiles.join(', ')}` };
  }

  const key =
    typeof connection === 'string' ? connection : (reachable.length === 1 ? reachable[0]! : '');
  if (!reachable.includes(key)) {
    return { error: `Name a connection within profile "${name}": ${reachable.join(', ')}` };
  }

  return { profile: name, connectionKey: key };
}
