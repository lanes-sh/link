import { ConfigError } from '#profile';
import type { Flags } from './argv.ts';
import { ACCEPTS } from './accepts.ts';
import { nearest } from './nearest.ts';

export { ACCEPTS } from './accepts.ts';

/**
 * Which commands must name a profile and a target, and which flags each accepts.
 *
 * Two rules, in one file because they fail for the same reason and the fix for
 * one makes the other legible.
 *
 * **A flag that is silently ignored is the defect.** `lanes link profile add
 * work --workspace cloud` printed `ok` and dropped the flag: `main.ts` built a
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
 * the target, and that the profiles behind it are every profile *in* it rather
 * than one the operator picks (ADR-043, ADR-052). `--profile` stays accepted
 * there, as a filter.
 *
 * There is no `profile`-alone level any more. Five commands sat there — the ones
 * that read a profile's file and open nothing — and it stopped being reachable
 * when a profile came to live inside one target's workspace: without a target
 * there is no file to read. The level is gone rather than left empty, so nobody
 * adds a sixth command to a level that cannot resolve.
 */
export type Requires = 'none' | 'workspace' | 'profile+workspace';

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
 * ceremony that teaches people to type `--workspace local` without reading it,
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
  mcp: 'none',
  'profile default': 'none',
  'workspace use': 'none',
  'target use': 'none',
  'vault key': 'none',
  // Listing the registry is what you run to find out what `--target` accepts, so
  // requiring the answer as input would be circular (ADR-052).
  workspace: 'none',
  // The old word, kept for one minor (ADR-061).
  target: 'none',
  'workspace list': 'none',
  'target list': 'none',

  // A profile lives in one target's workspace, so listing or creating one names
  // which workspace. `target show` follows the pointer, which `list` does not.
  profile: 'workspace',
  'profile list': 'workspace',
  'profile add': 'workspace',
  'profile remove': 'workspace',
  // Editing who may consume one profile, so it names the profile.
  'profile members': 'profile+workspace',
  'target show': 'workspace',

  // These read one profile's file and open nothing. The target is what says
  // which workspace holds it — required to *locate* the profile, not to open it.
  check: 'profile+workspace',
  config: 'profile+workspace',
  'config show': 'profile+workspace',
  policy: 'profile+workspace',
  'policy list': 'profile+workspace',
  identity: 'profile+workspace',
  'identity list': 'profile+workspace',
  'secrets push': 'profile+workspace',

  connect: 'profile+workspace',
  // Workspace-scoped: it answers "what has this workspace authorised", and a
  // profile would narrow the column rather than the rows.
  connection: 'workspace',
  'connection list': 'workspace',
  grant: 'profile+workspace',
  revoke: 'profile+workspace',
  // Both edit the profile config, and `disconnect` also opens the target's
  // credential store to delete from it. Same requirement as `connect` for the
  // same reasons.
  disconnect: 'profile+workspace',
  relabel: 'profile+workspace',
  // Its own row rather than an inheritance from `connect`. Both need the same
  // two things, but the row is what makes `selectionKey` return the two-word
  // key — and that is what keeps thirty declaration flags off
  // `connect <provider>`, where a mistyped one would otherwise be accepted and
  // ignored, which is the defect this whole file exists for.
  'connect custom': 'profile+workspace',
  setup: 'profile+workspace',
  token: 'profile+workspace',
  // One chain per workspace since contract 3, so the workspace is the subject
  // and `--profile` filters the rows rather than choosing which log to read.
  audit: 'workspace',
  secrets: 'profile+workspace',
  plan: 'profile+workspace',
  doctor: 'profile+workspace',
  auth: 'profile+workspace',
  // Target-scoped: see the note above. `--profile` narrows each to one profile.
  status: 'workspace',
  outputs: 'profile+workspace',
  tools: 'profile+workspace',
  // It resolves nothing and opens nothing — it hands macOS a URL (ADR-053).
  // `target list` is the precedent for a `'none'` command that still takes a
  // flag of its own. Both spellings need a row: `selection.test.ts` reads
  // `main.ts` for `case` labels, and a label with no row here falls through to
  // the `profile+target` default.
  dashboard: 'none',
  desktop: 'none',
  attach: 'profile+workspace',
  start: 'profile+workspace',
  deploy: 'workspace',
  // Both spellings: `sync` alone is `sync targets`, which is the only thing
  // there is to sync, and naming it leaves room for the next one.
  sync: 'workspace',
  'sync targets': 'workspace',
  'sync workspaces': 'workspace',
  'policy allow': 'profile+workspace',
  'policy deny': 'profile+workspace',
  // Both, unlike `identity list`, and for the same reason the policy edits are:
  // each publishes the edit, which opens the target's credential store and
  // reaches that target's endpoint.
  'identity add': 'profile+workspace',
  'identity remove': 'profile+workspace',
  'mcp install-instructions': 'none',
  // What it pairs is the workspace: the surface it opens lists every connection
  // and profile there, and the credential it mints reads all of them. Asking
  // which profile was a question with no answer. `--profile` still narrows, and
  // is how a port is chosen when profiles disagree about one.
  pair: 'workspace',
  'token show': 'profile+workspace',
  'token rotate': 'profile+workspace',
  'audit tail': 'workspace',
  'audit verify': 'workspace',
  'secrets set': 'profile+workspace',
  'secrets list': 'profile+workspace',
  'mcp add': 'profile+workspace',
  'mcp stdio': 'profile+workspace',
  memory: 'profile+workspace',
  tasks: 'profile+workspace',
  assets: 'profile+workspace',
  skills: 'profile+workspace',
  vault: 'profile+workspace',
  entities: 'profile+workspace',
  // Both halves open the target's adapters — `show` counts what is in the
  // stores, and `use` migrates between them — and both edit the profile's
  // config. Neither can be answered without being told which.
  knowledge: 'profile+workspace',
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
  profile: ['add', 'list', 'default', 'remove', 'members'],
  connection: ['list'],
  workspace: ['list', 'use', 'show'],
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
  // No `list`: a bare `entities` is a listing, which is `find` with no
  // criteria. One concept, one word.
  entities: ['find', 'get', 'write', 'link', 'forget', 'reindex'],
  mcp: ['skill', 'add', 'stdio', 'list'],
  secrets: ['push', 'set', 'list'],
  knowledge: ['show', 'use'],
  sync: ['targets', 'workspaces'],
};

/**
 * Whether the switch is going to refuse this command path anyway.
 *
 * When it is, these checks stay quiet and let it: "Unknown: lanes link vault
 * bogus" is the useful sentence, and a complaint about `--profile` on a command
 * that does not exist sends someone off to fix the wrong thing.
 */
export function dispatchWillRefuse(first: string, second: string | undefined): boolean {
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
  return SELECTION[selectionKey(first, second)] ?? 'profile+workspace';
}

/**
 * The commands that refuse `default_workspace` and make you type the name.
 *
 * ADR-037 removed every implicit selection, on reasoning worth keeping: a
 * persisted context is the standard way an operator runs a destructive command
 * against the wrong thing. ADR-061 gives the default back for the forty
 * commands a day that only read, and keeps the refusal exactly where that
 * argument bites — anything that publishes or destroys.
 *
 * `connect` is deliberately absent. It creates rather than destroys, it is the
 * command someone runs while learning the tool, and it prints the workspace it
 * wrote to. Requiring a flag there is the ceremony ADR-043 identified as the way
 * a required flag stops being a guard.
 */
export const EXPLICIT_WORKSPACE = new Set([
  'deploy',
  'sync',
  'sync targets',
  'sync workspaces',
  'secrets push',
  'profile remove',
  'disconnect',
  'token rotate',
]);

const UNIVERSAL = ['help', 'json', 'quiet'];

/**
 * Refuse a flag this command does not read, and guess what was meant.
 *
 * This is the fix for the reported bug rather than a nicety. `profile add
 * --workspace cloud` was accepted and dropped, and nothing could refuse it because
 * `parseArgv` returns every `--anything` it sees and no command ever inspected
 * the leftovers. A typo was swallowed the same way on every command in the CLI.
 */
/**
 * Commands that name their profile as an argument, and so refuse the flag.
 *
 * A `--profile` here could only name a *second* profile and disagree with the
 * positional one. They needed no exception while both sat at `none`; ADR-052
 * moved them to `target`, which made them inherit `--profile` from the rule
 * below.
 */
const POSITIONAL_PROFILE = new Set(['profile add', 'profile remove']);

export function assertKnownFlags(first: string, second: string | undefined, flags: Flags): void {
  if (dispatchWillRefuse(first, second)) return;

  const key = selectionKey(first, second);
  const needs = SELECTION[key] ?? 'profile+workspace';

  const allowed = new Set<string>([
    ...UNIVERSAL,
    ...(ACCEPTS[key] ?? []),
    // `target` accepts both: the target is what it acts on, and `--profile`
    // narrows it to one of the profiles behind it.
    ...(needs !== 'none' && !POSITIONAL_PROFILE.has(key) ? ['profile'] : []),
    ...(needs === 'workspace' || needs === 'profile+workspace' ? ['workspace'] : []),
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
