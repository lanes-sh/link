import { keepKeys, redactAllValues } from '#audit';
import type { ProviderManifest } from '#connectivity';

/**
 * What an invocation's arguments look like once they are in the audit log.
 *
 * Its own file because it answers a different question from the one the
 * dispatcher is asking. `invoke` decides whether a call may happen; this
 * decides what is written down about it either way — which is why it runs
 * before the allow/deny branch rather than after, so a denial is recorded with
 * the same redaction an allowed call would have got.
 *
 * Two sources, one precedence. A capability we authored carries its own rule
 * and knows what is sensitive in its own arguments. A discovered one cannot: we
 * did not write it, so the default withholds every value and a manifest opts
 * specific keys back in by name.
 */
export function auditArgumentsFor(input: {
  readonly manifest: ProviderManifest;
  readonly name: string | undefined;
  readonly own: ((args: Record<string, unknown>) => Record<string, unknown>) | undefined;
  readonly arguments: Record<string, unknown>;
}): Record<string, unknown> {
  const declaredKeys = input.manifest.redact?.[input.name ?? ''];
  const redact = input.own ?? (declaredKeys ? keepKeys(...declaredKeys) : undefined);

  return (redact ?? redactAllValues)(input.arguments);
}
