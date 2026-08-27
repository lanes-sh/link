import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  SUPPORTED_CONTRACT,
  configSchema,
  type Config,
  type PolicyRuleConfig,
} from './schema.ts';
import { findSecrets, formatSecretFindings } from './secret-detection.ts';

export class ConfigError extends Error {
  readonly findings: readonly string[];

  constructor(message: string, findings: readonly string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.findings = findings;
  }
}

export interface LoadedConfig {
  readonly config: Config;
  readonly source: string;
  /** `provider.id` for every declared connection, in declaration order. */
  readonly connectionKeys: readonly string[];
}

/**
 * Validate a raw parsed config.
 *
 * Order matters and is not arbitrary:
 *
 *  1. Contract major, before anything else. An unrecognised major means we do
 *     not know what the rest of the document means, so no further rule can be
 *     trusted to be reading what the operator wrote.
 *  2. Secret detection, on the RAW object rather than the parsed one. Zod
 *     strips unknown keys, so a credential parked under a misspelled key would
 *     survive schema validation invisibly.
 *  3. Schema shape.
 *  4. Referential integrity, which needs a well-formed document to check.
 */
export function validateConfig(raw: unknown, source = '<config>'): Config {
  const config = validateConfigShape(raw, source);
  assertReferentialIntegrity(config, source);
  return config;
}

/**
 * The first three steps, without the fourth.
 *
 * Only one caller, and it is the repair: `migrateRenamedProviders` has to open
 * the credential store of a config that referential integrity has just refused,
 * because whether a credential is stored is the evidence deciding which of two
 * readings a row gets. A shape-valid document is enough to name a target's
 * adapter, and nothing here trusts the part that failed.
 *
 * Not exported as a way to *load* a config. Everything that acts on one goes
 * through `validateConfig`, and the split exists so that the one command whose
 * job is to fix a refusal is not blocked by it.
 */
export function validateConfigShape(raw: unknown, source = '<config>'): Config {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${source}: expected a YAML mapping at the top level`);
  }

  assertSupportedContract(raw, source);

  const secrets = findSecrets(raw);
  if (secrets.length > 0) {
    throw new ConfigError(
      `${source}: ${formatSecretFindings(secrets)}`,
      secrets.map((finding) => finding.path),
    );
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${source}:\n${formatZodIssues(parsed.error)}`);
  }

  return parsed.data;
}

/**
 * An unknown contract major is rejected outright, never loaded best-effort.
 *
 * This file governs authorization. Guessing at a schema we do not implement
 * risks reading a document as more permissive than the operator wrote it, and
 * refusing to start is always the safer failure.
 */
function assertSupportedContract(raw: object, source: string): void {
  const contract = (raw as { contract?: unknown }).contract;

  if (typeof contract !== 'number' || !Number.isInteger(contract)) {
    throw new ConfigError(
      `${source}: "contract" is required and must be an integer. This binary implements contract ${SUPPORTED_CONTRACT}.`,
    );
  }

  if (contract !== SUPPORTED_CONTRACT) {
    const direction = contract > SUPPORTED_CONTRACT ? 'newer than' : 'older than';
    throw new ConfigError(
      `${source}: contract ${contract} is ${direction} the contract this binary implements (${SUPPORTED_CONTRACT}). ` +
        `Refusing to load rather than guessing at what the document means. ` +
        (contract > SUPPORTED_CONTRACT
          ? 'Upgrade lanes-link.'
          : 'Migrate the config, or use a matching lanes-link version.'),
    );
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `  ${path}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Cross-references, all of which fail rather than degrade.
 *
 * A policy rule naming a connection that does not exist is the important one:
 * left to resolve silently it grants nothing, which looks identical to a
 * working rule until the day someone relies on it.
 */
/**
 * A connection naming a provider whose id has moved out from under it.
 *
 * There is exactly one, and it is the reason this function exists: `tasks` was
 * Google Tasks until the built-in task list took the plain noun (ADR-052). A row
 * left saying `provider: tasks` does not fail — it resolves to the *built-in*,
 * `reconcile` marks it active because a provider needing no credential is
 * authorized by construction, and the operator is left with their Google Tasks
 * tools gone, a task list wearing their old label, and nothing anywhere saying
 * why. Refusing is the only outcome that names the fix.
 *
 * **The rule is a positive assertion, not a guess at what a vendor row looks
 * like.** The built-in's row is written in exactly one spelling, by
 * `newProfileTemplate` and by `ensureReservedConnection`: `account: Tasks`. So
 * any other label on a `tasks` row is either a pre-rename Google Tasks row or a
 * hand-edited built-in one, and the message names both fixes because either is
 * one word.
 *
 * It was very nearly a guess, and the guess was wrong. The first version keyed
 * on an `@` in the account, reasoning that `connect tasks` recorded the address
 * the operator typed — Google Tasks publishes no identity, so `connect` asks.
 * But what it asks for is a *label*: the real profile this was written for holds
 * `account: personal`, so the check would have passed it and rebound their Google
 * Tasks to the built-in in silence. That is the exact failure this exists to
 * prevent, missed by one heuristic.
 *
 * Deliberately not a check on the connection *id*. Several task lists in one
 * profile is a legitimate thing to want, exactly as several memory connections
 * are, and keying on `id !== 'main'` would refuse a valid profile forever to
 * catch a one-release migration. Labelling both `Tasks` is consistent with what
 * the accountless providers already do — every memory connection is `Memory`.
 *
 * **The refusal names a command, because it is a refusal at load.** Every
 * command opens the config, so this one takes `status`, `start` and `doctor`
 * down together and leaves hand-editing YAML as the only way back — for a state
 * an upgrade put the operator in, without asking. `doctor --fix` is that way
 * back, and it is named here because this is the only place anyone sees.
 */
export interface ProviderRename {
  /** What a row naming the old id should say instead. */
  readonly to: string;
  /** The account label that means this row is the built-in, not a vendor one. */
  readonly keeps: string;
  /** What the plain noun now names, for the sentence below. */
  readonly becomes: string;
  /** What it used to name. */
  readonly was: string;
  /** The built-in, in the operator's words. */
  readonly noun: string;
}

/**
 * Provider ids that have moved, and everything two places need to agree on.
 *
 * `renamedProviderFor` refuses a row still naming the old id; `#cli`'s
 * `migrateRenamedProviders` rewrites one. A rename landing in one and not the
 * other is a refusal with no fix, or a fix nothing asks for — which is why the
 * pair reads from one table rather than each knowing the rename itself.
 *
 * `keeps` is the single spelling `newProfileTemplate` and `ensureReservedConnection`
 * write for the built-in's row. Keep it in step with `RESERVED_SURFACES` there.
 */
export const RENAMED_PROVIDERS: Readonly<Record<string, ProviderRename>> = {
  tasks: {
    to: 'google_tasks',
    keeps: 'Tasks',
    becomes: 'the built-in task list',
    was: 'Google Tasks',
    noun: 'task list',
  },
};

/**
 * The repair, spelled with the selection it will refuse without.
 *
 * The profile comes off the document being validated rather than off the command
 * that is running, because nothing has resolved anything yet and the name is
 * written in the file. The target cannot come from there any more — a profile
 * declares none (ADR-052) — so it stays a placeholder. That is honest rather
 * than lossy: the file being repaired lives in exactly one target's workspace,
 * and whoever is reading this refusal just typed which one.
 */
function repairCommand(config: Config): string {
  return `lanes link doctor --fix --profile ${config.instance.profile} --target <target>`;
}

/** The rename a row is owed, or `null` when it is owed none. */
export function renamedProviderFor(connection: {
  provider: string;
  account: string;
}): ProviderRename | null {
  const moved = RENAMED_PROVIDERS[connection.provider];
  if (!moved || connection.account === moved.keeps) return null;
  return moved;
}

function renamedProvider(
  connection: { provider: string; account: string },
  repair: string,
): string | null {
  const moved = renamedProviderFor(connection);
  if (!moved) return null;

  return (
    `"${connection.provider}" is now ${moved.becomes}, and this row is labelled ` +
    `"${connection.account}" rather than "${moved.keeps}".\n` +
    `  If it was ${moved.was}: set provider to ${moved.to} here, and rename any ` +
    `"${connection.provider}.*" policy rule.\n` +
    `  If it is your own ${moved.noun}: set account to ${moved.keeps}.\n` +
    `  ${repair} applies the first, where a stored credential proves it.`
  );
}

function assertReferentialIntegrity(config: Config, source: string): void {
  const problems: string[] = [];

  // There is nothing to check about targets here any more. A profile declares
  // none (ADR-052): the workspace holding this file declares the one target it
  // lives in, and `workspaceSchema` is what validates that. A profile is now
  // portable between targets precisely because it says nothing about them.

  // Connection ids are unique per provider, so `gmail.main` and
  // `icloud_mail.main` can coexist.
  const connectionKeys = new Set<string>();
  const providerNames = new Set(config.connections.map((connection) => connection.provider));

  config.connections.forEach((connection, index) => {
    const key = `${connection.provider}.${connection.id}`;
    if (connectionKeys.has(key)) {
      problems.push(`connections[${index}]: duplicate connection "${key}"`);
    }
    connectionKeys.add(key);

    const renamed = renamedProvider(connection, repairCommand(config));
    if (renamed) problems.push(`connections[${index}]: ${renamed}`);
  });

  // Same reason as a duplicate connection: two entries with the same kind and
  // value cannot both be meant, and the one that loses is invisible. It matters
  // more here than it looks, because the two would usually differ only in their
  // `note` — so the discarded one is precisely the guidance someone wrote down
  // to stop an agent picking wrong.
  const identityKeys = new Set<string>();
  config.identity.forEach((entry, index) => {
    const key = `${entry.kind}=${entry.value}`;
    if (identityKeys.has(key)) {
      problems.push(`identity[${index}]: duplicate entry "${entry.kind}: ${entry.value}"`);
    }
    identityKeys.add(key);
  });

  const checkRules = (rules: readonly PolicyRuleConfig[], field: 'allow' | 'deny'): void => {
    rules.forEach((rule, index) => {
      const where = `policy.${field}[${index}]`;
      if (rule.capability === '*') return;

      // A rule naming a provider with no connection is almost always a typo,
      // and one that fails open-looking: it reads as a grant while matching
      // nothing. Worth saying, but not fatal for a `deny` — denying something
      // you have not connected yet is a perfectly reasonable thing to write
      // ahead of time.
      const providerOfCapability = rule.capability.split('.')[0] ?? '';
      if (field === 'allow' && !providerNames.has(providerOfCapability)) {
        problems.push(
          `${where}: "${rule.capability}" names provider "${providerOfCapability}", which has no connection` +
            (providerNames.size > 0 ? ` (have: ${[...providerNames].join(', ')})` : ''),
        );
      }
    });
  };

  checkRules(config.policy.allow, 'allow');
  checkRules(config.policy.deny, 'deny');

  if (problems.length > 0) {
    throw new ConfigError(`${source}:\n${problems.map((p) => `  ${p}`).join('\n')}`, problems);
  }
}

export function parseConfig(text: string, source = '<config>'): LoadedConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`${source}: could not parse YAML — ${(error as Error).message}`);
  }

  const config = validateConfig(raw, source);
  return {
    config,
    source,
    connectionKeys: config.connections.map((c) => `${c.provider}.${c.id}`),
  };
}

export async function loadConfigFile(path: string): Promise<LoadedConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigError(`${path}: no such config file`);
  }
  return parseConfig(await file.text(), path);
}
