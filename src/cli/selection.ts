import {
  ConfigError,
  listProfiles,
  loadProfileConfig,
  noProfileNamed,
  noTargetNamed,
  resolveWorkspaceRoot,
} from '#profile';
import type { Flags } from './argv.ts';

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

/** What a command must be told before it can act. */
export type Requires = 'none' | 'profile' | 'profile+target';

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
 * `profile add` **rejects** both. The name is positional, and there is no
 * profile to select before it exists.
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
  'profile remove': 'profile',
  // Target-independent for the same reason `policy list` is: the block is
  // declared once in the YAML and applies to every target the profile has.
  identity: 'profile',
  'identity list': 'profile',

  connect: 'profile+target',
  setup: 'profile+target',
  token: 'profile+target',
  audit: 'profile+target',
  secrets: 'profile+target',
  plan: 'profile+target',
  doctor: 'profile+target',
  status: 'profile+target',
  outputs: 'profile+target',
  tools: 'profile+target',
  // It reads which target it is rendering for before it decides anything: a
  // deployed one has no page to open, and the refusal has to name it.
  dashboard: 'profile+target',
  attach: 'profile+target',
  start: 'profile+target',
  deploy: 'profile+target',
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
  skills: ['list', 'show', 'add', 'remove'],
  vault: ['list', 'get', 'set', 'remove', 'key'],
  mcp: ['skill', 'add', 'stdio', 'list'],
  secrets: ['push', 'set', 'list'],
  knowledge: ['show', 'use'],
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
  'profile remove': ['dry-run', 'yes'],
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
  dashboard: ['print'],
  skill: ['print', 'force'],
  deploy: ['dry-run', 'iam', 'access', 'service-account', 'tag', 'yes', 'non-interactive'],
  'secrets push': ['from', 'to', 'overwrite', 'dry-run'],
  update: ['check'],
  'identity add': ['note'],
  memory: ['connection', 'title', 'description', 'file'],
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
    ...(needs === 'profile' || needs === 'profile+target' ? ['profile'] : []),
    ...(needs === 'profile+target' ? ['target'] : []),
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

/**
 * The closest accepted flag, when there is an obviously close one.
 *
 * One edit away, or one transposition — enough for `--porfile` and `--taget`,
 * and short of guessing at something the operator did not mean. A wrong guess
 * here costs more than no guess: it sends them to a flag that is not the answer.
 */
function nearest(given: string, allowed: ReadonlySet<string>): string | undefined {
  for (const candidate of allowed) {
    if (Math.abs(candidate.length - given.length) > 1) continue;
    if (distance(given, candidate) <= 1) return candidate;
    if (sorted(given) === sorted(candidate)) return candidate;
  }
  return undefined;
}

const sorted = (text: string): string => [...text].sort().join('');

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }

  return row[b.length]!;
}
