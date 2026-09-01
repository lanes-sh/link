import type { Config } from '#profile';
import type { ConfigDocument } from '../../config-edit.ts';
import { matchesRule } from './accounts.ts';

/**
 * What connecting grants.
 *
 * One row naming the connection, carrying the wildcard for its provider — not
 * one rule per capability. The pinned-per-tool form this replaced was 85 lines
 * for four providers and unreadable, and what it bought — a vendor cannot widen
 * your policy by shipping a new tool — is preserved instead by `doctor`, which
 * reports capabilities that appeared after you connected.
 *
 * A row rather than a rule, since contract 3. The connection and the permission
 * used to be two writes into two blocks, which is what made "a row with no rule"
 * and "a rule with no row" both expressible and both silent: the first served
 * nothing, the second was refused at load. A grant is one thing now (ADR-058),
 * so neither state exists to be repaired.
 *
 * Idempotent, and by matching rather than by equality: a profile whose row for
 * this connection already holds a broader rule is not widened, and a second
 * connect to the same account adds nothing.
 */
export function grantConnection(
  document: ConfigDocument,
  config: Config,
  connection: string,
): string[] {
  const rule = `${connection.split('.')[0] ?? ''}.*`;
  const index = config.grants.findIndex((grant) => grant.connection === connection);

  if (index === -1) {
    document.addTo(['grants'], { connection, allow: [rule], deny: [] });
    return [rule];
  }

  const existing = config.grants[index]!;
  if (existing.allow.some((held) => matchesRule(held.capability, rule))) return [];

  document.addTo(['grants', index, 'allow'], rule, { inline: true });
  return [rule];
}
