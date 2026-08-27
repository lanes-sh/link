import type { ConfigDocument } from '../../config-edit.ts';
import { matchesRule } from './accounts.ts';

/**
 * What connecting grants.
 *
 * One rule per provider, not one per capability. The pinned-per-tool form this
 * replaced was 85 lines for four providers and unreadable, and what it bought —
 * a vendor cannot widen your policy by shipping a new tool — is preserved
 * instead by `doctor`, which reports capabilities that appeared after you
 * connected.
 *
 * Idempotent, and by matching rather than by equality: a profile already holding
 * a broader rule that covers this one is not widened, and a second connect to
 * the same provider adds nothing.
 */
export function grantProvider(
  document: ConfigDocument,
  allow: readonly { readonly capability: string }[],
  providerId: string,
): string[] {
  const rule = `${providerId}.*`;
  if (allow.some((existing) => matchesRule(existing.capability, rule))) return [];

  document.addTo(['policy', 'allow'], rule, { inline: true });
  return [rule];
}
