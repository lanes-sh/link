import { ConfigError } from '#profile';
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
export type Requires = 'none' | 'target' | 'profile+target';

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
  mcp: 'none',
  'profile default': 'none',
  'target use': 'none',
  'vault key': 'none',
  // Listing the registry is what you run to find out what `--target` accepts, so
  // requiring the answer as input would be circular (ADR-052).
  target: 'none',
  'target list': 'none',

  // A profile lives in one target's workspace, so listing or creating one names
  // which workspace. `target show` follows the pointer, which `list` does not.
  profile: 'target',
  'profile list': 'target',
  'profile add': 'target',
  'profile remove': 'target',
  'target show': 'target',

  // These read one profile's file and open nothing. The target is what says
  // which workspace holds it — required to *locate* the profile, not to open it.
  check: 'profile+target',
  config: 'profile+target',
  'config show': 'profile+target',
  policy: 'profile+target',
  'policy list': 'profile+target',
  identity: 'profile+target',
  'identity list': 'profile+target',
  'secrets push': 'profile+target',

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
  // It resolves nothing and opens nothing — it hands macOS a URL (ADR-053).
  // `target list` is the precedent for a `'none'` command that still takes a
  // flag of its own. Both spellings need a row: `selection.test.ts` reads
  // `main.ts` for `case` labels, and a label with no row here falls through to
  // the `profile+target` default.
  dashboard: 'none',
  desktop: 'none',
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
  return SELECTION[selectionKey(first, second)] ?? 'profile+target';
}

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
    'label',
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
  // The one repair `doctor` can apply rather than only name. Narrow on purpose:
  // it undoes a provider rename this project shipped, and every other finding
  // there is something only the operator can decide.
  doctor: ['fix'],
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
  // `--yes` because it installs the app when nothing answers the scheme, and
  // that is the one prompt in this CLI that puts an application on the machine.
  dashboard: ['print', 'yes'],
  desktop: ['print', 'yes'],
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
  const needs = SELECTION[key] ?? 'profile+target';

  const allowed = new Set<string>([
    ...UNIVERSAL,
    ...(ACCEPTS[key] ?? []),
    // `target` accepts both: the target is what it acts on, and `--profile`
    // narrows it to one of the profiles behind it.
    ...(needs !== 'none' && !POSITIONAL_PROFILE.has(key) ? ['profile'] : []),
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
