import {
  ConfigError,
  listProfiles,
  loadProfileConfig,
  loadWorkspaceProfiles,
  noProfileNamed,
  noTargetInWorkspace,
  noTargetNamed,
  resolveWorkspaceRoot,
  targetsByName,
} from '#profile';
import type { Flags } from './argv.ts';
import { CONNECT_CUSTOM_FLAGS } from './commands/connect/custom/spec.ts';
import { nearest } from './nearest.ts';

/**
 * Which commands must name a profile and a target, and which flags each accepts.
 *
 * Two rules, in one file because they fail for the same reason and the fix for
 * one makes the other legible.
 *
 * **A flag that is silently ignored is the defect.** `lanes link profile add
 * work --target cloud` printed `ok` and dropped the flag: `main.ts` built a
 * literal for that command and never spread the global flags into it. Nothing
 * refused, because nothing had a list of what the command accepts. That is what
 * `assertKnownFlags` is — and it matters more than the requirement, because
 * required flags make a typo *worse* on their own. `--porfile work` used to
 * fall through to a workspace default and mostly work; with a requirement and
 * no allowlist it produces "--profile is required", naming a flag the operator
 * believes they just passed.
 *
 * **A selection is named or the command does not run** (ADR-037). The table
 * below is the whole rule, and `selection.test.ts` reads `main.ts` to check that
 * every dispatched command appears in it — so a new command cannot quietly
 * default to requiring nothing.
 */

/**
 * What a command must be told before it can act.
 *
 * `target` is not a weaker `profile+target`. It says the command's subject *is*
 * the target, and that the profiles behind it are every profile declaring it
 * rather than one the operator picks (ADR-043). `--profile` stays accepted
 * there, as a filter.
 */
export type Requires = 'none' | 'profile' | 'target' | 'profile+target';

/**
 * The rule, per command path.
 *
 * `--profile` for anything that reads or writes a profile's config or stores.
 * `--target` for anything that opens a target's adapters or acts against a
 * target's endpoint. A command that names a target positionally or through
 * `--from`/`--to` supplies it that way and is not asked twice.
 *
 * Three entries are worth defending, because uniformity would be wrong:
 *
 * `check`, `config show` and `policy list` take no `--target`. All three are
 * target-independent — a YAML file, the whole of it, and a policy block that is
 * declared once and applies everywhere. Demanding a target would be the
 * ceremony that teaches people to type `--target local` without reading it,
 * which is how a required flag stops being a guard.
 *
 * `target list` takes no required `--target` either, and that is not an
 * oversight: it is the command you run to find out what to pass. Requiring the
 * answer as input is circular, and it has to keep working in the state every
 * other command fails in.
 *
 * `status`, `deploy` and `sync targets` take `target` rather than
 * `profile+target`. One deployed endpoint serves every profile in the workspace
 * (ADR-009), so the profile set behind a target is enumerable from the config
 * and naming one of them describes a slice, not the subject. That is not the
 * inference ADR-037 removed: there is nothing to guess at, and nothing is
 * silently chosen.
 *
 * `profile add` and `profile remove` **reject** `--profile`. Both name their
 * profile positionally, so a flag naming a second one could only disagree with
 * it. `add` has no profile to select before it exists; `remove` takes an
 * optional `--target` to decommission one target's stores and keep the file.
 */
export const SELECTION: Record<string, Requires> = {
  help: 'none',
  version: 'none',
  update: 'none',
  skill: 'none',
  'mcp skill': 'none',
  'mcp list': 'none',
  // The bare forms, which each dispatch to a `case undefined` in `main.ts`.
  // `lanes link profile` is `profile list`, and needs the same as it.
  profile: 'none',
  mcp: 'none',
  'profile list': 'none',
  'profile add': 'none',
  'profile default': 'none',
  'target use': 'none',
  'vault key': 'none',

  check: 'profile',
  config: 'profile',
  policy: 'profile',
  target: 'profile',
  'config show': 'profile',
  'policy list': 'profile',
  'target list': 'profile',
  'target show': 'profile',
  'secrets push': 'profile',
  'profile remove': 'none',
  // Target-independent for the same reason `policy list` is: the block is
  // declared once in the YAML and applies to every target the profile has.
  identity: 'profile',
  'identity list': 'profile',

  connect: 'profile+target',
  // Both edit the profile config, and `disconnect` also opens the target's
  // credential store to delete from it. Same requirement as `connect` for the
  // same reasons.
  disconnect: 'profile+target',
  relabel: 'profile+target',
  // Its own row rather than an inheritance from `connect`. Both need the same
  // two things, but the row is what makes `selectionKey` return the two-word
  // key — and that is what keeps thirty declaration flags off
  // `connect <provider>`, where a mistyped one would otherwise be accepted and
  // ignored, which is the defect this whole file exists for.
  'connect custom': 'profile+target',
  setup: 'profile+target',
  token: 'profile+target',
  audit: 'profile+target',
  secrets: 'profile+target',
  plan: 'profile+target',
  doctor: 'profile+target',
  // Target-scoped: see the note above. `--profile` narrows each to one profile.
  status: 'target',
  outputs: 'profile+target',
  tools: 'profile+target',
  // It reads which target it is rendering for before it decides anything: a
  // deployed one has no page to open, and the refusal has to name it.
  dashboard: 'profile+target',
  attach: 'profile+target',
  start: 'profile+target',
  deploy: 'target',
  // Both spellings: `sync` alone is `sync targets`, which is the only thing
  // there is to sync, and naming it leaves room for the next one.
  sync: 'target',
  'sync targets': 'target',
  'policy allow': 'profile+target',
  'policy deny': 'profile+target',
  // Both, unlike `identity list`, and for the same reason the policy edits are:
  // each publishes the edit, which opens the target's credential store and
  // reaches that target's endpoint.
  'identity add': 'profile+target',
  'identity remove': 'profile+target',
  'token show': 'profile+target',
  'token rotate': 'profile+target',
  'audit tail': 'profile+target',
  'audit verify': 'profile+target',
  'secrets set': 'profile+target',
  'secrets list': 'profile+target',
  'mcp add': 'profile+target',
  'mcp stdio': 'profile+target',
  memory: 'profile+target',
  tasks: 'profile+target',
  assets: 'profile+target',
  skills: 'profile+target',
  vault: 'profile+target',
  // Both halves open the target's adapters — `show` counts what is in the
  // stores, and `use` migrates between them — and both edit the profile's
  // config. Neither can be answered without being told which.
  knowledge: 'profile+target',
};

/**
 * The second words each command accepts.
 *
 * Only the commands that have subcommands appear. This exists for one reason:
 * the checks below run before the switch, so without it `lanes link vault bogus`
 * is refused for a missing `--profile` rather than for the subcommand that does
 * not exist — a usage error reported as the wrong usage error, which is its own
 * small version of the bug being fixed. `selection.test.ts` reads `main.ts` and
 * asserts this stays true.
 */
const SUBCOMMANDS: Record<string, readonly string[]> = {
  profile: ['add', 'list', 'default', 'remove'],
  target: ['list', 'use', 'show'],
  policy: ['list', 'allow', 'deny'],
  identity: ['add', 'list', 'remove'],
  token: ['show', 'rotate'],
  audit: ['tail', 'verify'],
  config: ['show'],
  setup: ['plan'],
  memory: ['list', 'get', 'write', 'forget'],
  tasks: ['list', 'get', 'add', 'update', 'remove'],
  assets: ['list', 'get', 'add', 'remove'],
  skills: ['list', 'show', 'add', 'remove'],
  vault: ['list', 'get', 'set', 'remove', 'key'],
  mcp: ['skill', 'add', 'stdio', 'list'],
  secrets: ['push', 'set', 'list'],
  knowledge: ['show', 'use'],
  sync: ['targets'],
};

/**
 * Whether the switch is going to refuse this command path anyway.
 *
 * When it is, these checks stay quiet and let it: "Unknown: lanes link vault
 * bogus" is the useful sentence, and a complaint about `--profile` on a command
 * that does not exist sends someone off to fix the wrong thing.
 */
function dispatchWillRefuse(first: string, second: string | undefined): boolean {
  const known = SUBCOMMANDS[first];
  if (!known || second === undefined) return false;
  return !known.includes(second);
}

/**
 * The key for a command, longest match first.
 *
 * `token show` before `token`, so a two-word command can differ from its
 * siblings without every sibling having to be listed.
 */
export function selectionKey(first: string, second: string | undefined): string {
  const pair = second ? `${first} ${second}` : first;
  if (pair in SELECTION) return pair;
  return first;
}

/** Whether this command needs a profile, a target, both, or neither. */
export function requirementFor(first: string, second: string | undefined): Requires {
  return SELECTION[selectionKey(first, second)] ?? 'profile+target';
}

/**
 * Refuse before the command runs, naming what it wants and what there is.
 *
 * Async, and it reads the workspace — but only on the way to throwing. The
 * useful half of "which profile did you mean" is the list of them, and the same
 * for targets; a refusal that only restates the flag name leaves someone to go
 * and look it up. Both messages come from `#profile` so this file and the
 * resolver cannot describe the same refusal differently, and both name an
 * exported variable that no longer counts — the shell still configured for the
 * old world is the state hardest to diagnose from the inside.
 */
export async function requireSelection(
  first: string,
  second: string | undefined,
  flags: Flags,
  env?: Record<string, string | undefined>,
): Promise<void> {
  if (dispatchWillRefuse(first, second)) return;

  const needs = requirementFor(first, second);
  if (needs === 'none') return;

  // Asked before the profile requirement, because for these there is none. The
  // refusal has to describe the workspace rather than one profile's targets,
  // since the command was never going to act on only one.
  if (needs === 'target') {
    if (typeof flags['target'] === 'string') return;
    const root = resolveWorkspaceRoot(env ? { env } : {});
    throw noTargetInWorkspace(targetsByName(await loadWorkspaceProfiles(root)), root, env);
  }

  const profile = flags['profile'];
  if (typeof profile !== 'string') {
    const root = resolveWorkspaceRoot(env ? { env } : {});
    throw noProfileNamed(root, await listProfiles(root), env);
  }

  if (needs !== 'profile+target' || typeof flags['target'] === 'string') return;

  // The profile is known by here, so the target list is the one belonging to it
  // rather than a guess. A profile that does not exist is a different refusal,
  // and `resolveSelection` gives it a better one a moment later.
  const root = resolveWorkspaceRoot(env ? { env } : {});
  try {
    const { config } = await loadProfileConfig(root, profile);
    throw noTargetNamed(config, profile, env);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`--target is required for "${[first, second].filter(Boolean).join(' ')}".`);
  }
}

/**
 * Flags every command accepts, whatever it does.
 *
 * `--help` short-circuits before dispatch, and `--json` is offered widely enough
 * that listing it per command would be noise. `--quiet` is read by `announce`
 * rather than by any one command.
 */
const UNIVERSAL = ['help', 'json', 'quiet'];

/**
 * What each command accepts beyond the universal set and its own selection.
 *
 * Only commands with flags of their own appear. Anything absent accepts the
 * universal set plus whatever `SELECTION` says it must be told.
 */
const ACCEPTS: Record<string, readonly string[]> = {
  // Imported rather than written out. Thirty-odd entries here would take this
  // file past the size budget for a data literal, and the command's own
  // `spec.ts` already derives most of them from the per-kind field tables — so
  // a flag added there cannot be forgotten here.
  'connect custom': CONNECT_CUSTOM_FLAGS,
  // `own-client` is the older spelling of one of the routes `auth` names, kept
  // because it is in scripts and a year of documentation (ADR-038).
  connect: [
    'id',
    'display-name',
    'replace',
    'non-interactive',
    'accept-broad-scopes',
    'own-client',
    'auth',
  ],
  setup: ['id'],
  'profile add': ['target', 'non-interactive'],
  // `--target` decommissions one target's stores and leaves the profile file in
  // place (`removal.ts`). It is documented in `usage.ts` and read by
  // `removalPlan`, and was refused here — the flag existed everywhere except in
  // the list that decides whether it may be typed.
  'profile remove': ['dry-run', 'yes', 'target'],
  disconnect: ['yes', 'keep-credential'],
  relabel: [],
  'target list': ['urls', 'target'],
  'target show': ['target'],
  'token show': ['show', 'raw'],
  'token rotate': ['show', 'raw', 'yes'],
  'audit tail': ['limit', 'denied-only', 'format'],
  'audit verify': ['limit', 'format'],
  attach: ['connection'],
  outputs: ['show'],
  start: ['port', 'only'],
  'mcp stdio': ['only'],
  'mcp add': ['name', 'scope', 'token-env', 'dry-run', 'force', 'no-skill'],
  'mcp skill': ['print', 'force'],
  'mcp list': ['name', 'scope'],
  dashboard: ['print'],
  skill: ['print', 'force'],
  deploy: ['dry-run', 'iam', 'access', 'service-account', 'tag', 'yes', 'non-interactive'],
  'secrets push': ['from', 'to', 'overwrite', 'dry-run'],
  sync: ['dry-run', 'from', 'discover', 'prefer'],
  'sync targets': ['dry-run', 'from', 'discover', 'prefer'],
  update: ['check'],
  'identity add': ['note'],
  memory: ['connection', 'title', 'description', 'file', 'tag'],
  // `--yes` on both, because both have a delete that asks first.
  tasks: ['connection', 'title', 'status', 'due', 'tag', 'yes'],
  assets: ['connection', 'name', 'content-type', 'yes'],
  skills: ['connection', 'title', 'description', 'file'],
  vault: ['connection'],
  // `no-migrate` is listed beside `migrate` because they are three states
  // rather than two: neither one asks, and a run with no terminal has to be
  // able to say which it meant (ADR-041).
  knowledge: ['repo', 'branch', 'path', 'migrate', 'no-migrate', 'keep', 'allow-public', 'replace', 'yes'],
};

/**
 * Refuse a flag this command does not read, and guess what was meant.
 *
 * This is the fix for the reported bug rather than a nicety. `profile add
 * --target cloud` was accepted and dropped, and nothing could refuse it because
 * `parseArgv` returns every `--anything` it sees and no command ever inspected
 * the leftovers. A typo was swallowed the same way on every command in the CLI.
 */
export function assertKnownFlags(first: string, second: string | undefined, flags: Flags): void {
  if (dispatchWillRefuse(first, second)) return;

  const key = selectionKey(first, second);
  const needs = SELECTION[key] ?? 'profile+target';

  const allowed = new Set<string>([
    ...UNIVERSAL,
    ...(ACCEPTS[key] ?? []),
    // `target` accepts both: the target is what it acts on, and `--profile`
    // narrows it to one of the profiles behind it.
    ...(needs !== 'none' ? ['profile'] : []),
    ...(needs === 'target' || needs === 'profile+target' ? ['target'] : []),
  ]);

  const named = [first, second].filter(Boolean).join(' ');

  for (const given of Object.keys(flags)) {
    if (allowed.has(given)) continue;

    throw new ConfigError(
      `Unknown flag "--${given}" for "lanes link ${named}".` +
        (nearest(given, allowed) ? `\n  Did you mean --${nearest(given, allowed)}?` : '') +
        `\n  Accepts: ${[...allowed].sort().map((name) => `--${name}`).join(' ')}`,
    );
  }
}
