import type { PolicyDocument, PolicyRule, ProfilePolicy } from '#policy';
import type { Config, GrantConfig } from '#profile';

/**
 * Turn the config's `grants:` rows into the documents the policy engine
 * evaluates.
 *
 * Two format differences are reconciled here, and keeping them in one place is
 * what stops either leaking into the other side.
 *
 * The config keeps `allow` and `deny` as separate lists because that is what
 * reads clearly in YAML; the engine wants one list carrying an effect, because
 * evaluation must consider both together to make deny win regardless of
 * ordering.
 *
 * And the config is a *sequence* of rows while the engine wants a lookup by
 * connection (ADR-058). A profile cannot declare the same connection twice —
 * `assertGrantsResolve` refuses it at load, precisely so that this conversion
 * has no collision to resolve and no precedence to invent.
 *
 * This is the only place `#profile`'s shape meets `#policy`'s. `#policy` may
 * not import `#profile` and does not need to: it takes a map of rule lists and
 * knows nothing about YAML, grants, or where a connection was declared.
 */
export function toPolicyDocument(config: Config): ProfilePolicy {
  const byConnection = new Map<string, PolicyDocument>();

  for (const grant of config.grants) {
    byConnection.set(grant.connection, { rules: rulesFor(grant) });
  }

  return { byConnection };
}

function rulesFor(grant: GrantConfig): PolicyRule[] {
  const rules: PolicyRule[] = [];

  for (const [effect, entries] of [
    ['allow', grant.allow],
    ['deny', grant.deny],
  ] as const) {
    for (const entry of entries) {
      rules.push({
        capability: entry.capability,
        effect,
        ...('expires_at' in entry && entry.expires_at
          ? { expiresAt: new Date(entry.expires_at) }
          : {}),
      });
    }
  }

  return rules;
}
