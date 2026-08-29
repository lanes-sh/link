import { z } from 'zod';
import {
  auditTargetSchema,
  credentialsTargetSchema,
  DEPLOY_DEFAULTS,
  deployTargetSchema,
  storageTargetSchema,
  vaultTargetSchema,
} from './schema.ts';
import { knowledgeTargetSchema } from './knowledge.ts';

/**
 * Contract 1, understood well enough to migrate away from.
 *
 * The runtime does not read this and must not start. A binary that loaded either
 * shape would be the two-sources-of-truth problem ADR-052 removed, one level up:
 * two spellings of "where does this target live", both valid, disagreeing
 * silently. `SUPPORTED_CONTRACT` is 2 and a contract-1 file is refused
 * everywhere except here.
 *
 * Deliberately loose. It parses only what the migration has to *move* — the
 * `targets:` block and its adapters — and passes everything else through
 * untouched, because the migration edits the YAML document rather than
 * re-rendering it from a parsed shape. A file with a problem this schema cannot
 * see is a file the contract-2 loader will report properly once the structure is
 * right, and that order is on purpose: a stale connection row must not block the
 * structural fix.
 */

/**
 * The `cloudrun:` block `deploy:` replaced.
 *
 * Normalised here rather than in `schema.ts`, which is where it used to live.
 * Contract 2 has no reason to carry a spelling nothing has written for two
 * releases, and the migration is the last thing that will ever read one.
 */
const legacyCloudRunSchema = z.object({
  project: z.string(),
  region: z.string(),
  service: z.string(),
});

export const legacyTargetSchema = z
  .object({
    credentials: credentialsTargetSchema,
    audit: auditTargetSchema.optional(),
    storage: storageTargetSchema,
    vault: vaultTargetSchema.optional(),
    knowledge: knowledgeTargetSchema.optional(),
    deploy: deployTargetSchema.optional(),
    cloudrun: legacyCloudRunSchema.optional(),
  })
  .transform(({ cloudrun, ...target }) =>
    target.deploy || !cloudrun
      ? target
      : {
          ...target,
          // The pre-`deploy` spelling predates all of these, so it gets the
          // same defaults the current one would: the closed door, no instance
          // kept warm, and the ceilings a public URL is deployed under. Built by
          // hand here rather than parsed, so `DEPLOY_DEFAULTS` is spread rather
          // than left to zod — a block that reaches `deployPlan` without them
          // sends `undefined` to `gcloud` as the string "undefined".
          deploy: {
            ...cloudrun,
            platform: 'cloudrun' as const,
            access: 'iam' as const,
            min_instances: 0,
            ...DEPLOY_DEFAULTS,
          },
        },
  );

/** A contract-1 profile, as far as the migration needs to understand one. */
export const legacyConfigSchema = z.object({
  contract: z.literal(1),
  instance: z.object({ profile: z.string() }).passthrough(),
  targets: z.record(z.string(), legacyTargetSchema).default({}),
});

export type LegacyTarget = z.infer<typeof legacyTargetSchema>;
export type LegacyConfig = z.infer<typeof legacyConfigSchema>;

/** Whether a parsed document is a contract-1 profile, without throwing on one. */
export function isLegacyProfile(raw: unknown): boolean {
  return (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (raw as { contract?: unknown }).contract === 1
  );
}

/** Whether a parsed workspace file is contract 1. Same test, different file. */
export function isLegacyWorkspace(raw: unknown): boolean {
  return isLegacyProfile(raw);
}
