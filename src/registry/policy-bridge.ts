import type { PolicyDocument, PolicyRule } from '#policy';
import type { Config } from '#profile';

/**
 * Turn the config's `policy` block into the document the policy engine
 * evaluates.
 *
 * The config format keeps `allow` and `deny` as separate lists because that is
 * what reads clearly in YAML; the engine wants one list carrying an effect,
 * because evaluation must consider both together to make deny win regardless of
 * ordering. Converting here keeps that difference from leaking either way.
 */
export function toPolicyDocument(config: Config): PolicyDocument {
  const rules: PolicyRule[] = [];

  for (const [effect, entries] of [
    ['allow', config.policy.allow],
    ['deny', config.policy.deny],
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

  return { rules };
}
