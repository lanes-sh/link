import { CONNECT_CUSTOM_FLAGS } from './commands/connect/custom/spec.ts';

/**
 * The flags each command reads, beyond the universal set and its own selection.
 *
 * Split from `selection.ts` so that file stays inside the size budget, and on
 * the seam it already had: that file answers *what a command must be told*, and
 * this answers *what it will listen to*. Both are read by `assertKnownFlags`,
 * and a flag missing from here is refused rather than ignored — which is the
 * defect the whole arrangement exists to prevent.
 */

/**
 * What each command accepts beyond the universal set and its own selection.
 *
 * Only commands with flags of their own appear. Anything absent accepts the
 * universal set plus whatever `SELECTION` says it must be told.
 */
export const ACCEPTS: Record<string, readonly string[]> = {
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
    // Repeatable: `--set host=cloud.example.com`. The only way to give a
    // provider its address without a terminal to ask at.
    'set',
    'label',
    'replace',
    'non-interactive',
    'accept-broad-scopes',
    'own-client',
    'auth',
  ],
  setup: ['id'],
  'profile add': ['workspace', 'non-interactive'],
  // `--delete-data` and `--migrate-to` say what becomes of the bytes the
  // profile owns (ADR-066). Neither is optional in effect: `--yes` skips
  // confirmations of things the command was told to do, and this is a question
  // it has not been asked, so a run with no terminal is refused rather than
  // guessing.
  'profile remove': ['dry-run', 'yes', 'workspace', 'delete-data', 'migrate-to'],
  'profile members': ['me', 'role'],
  disconnect: ['yes', 'keep-credential'],
  // The one repair `doctor` can apply rather than only name. Narrow on purpose:
  // it undoes a provider rename this project shipped, and every other finding
  // there is something only the operator can decide.
  doctor: ['fix'],
  // Declaring a connection names the account itself, because nothing can be
  // asked of a provider that is not authorised yet — see `connection-declare.ts`.
  'connection declare': ['id', 'account', 'label'],
  relabel: [],
  // A rule lands in a grant row, and a row names one connection (ADR-058), so
  // the flag is required rather than optional. It is listed here as well as
  // enforced in the command because `assertKnownFlags` refuses anything absent
  // from this table — the flag existing everywhere except the allowlist is the
  // exact defect this file was written for.
  'policy allow': ['connection'],
  'policy deny': ['connection'],
  'workspace list': ['urls', 'workspace'],
  'target list': ['urls', 'workspace'],
  'workspace show': ['workspace'],
  'target show': ['workspace'],
  'mcp install-instructions': ['client'],
  pair: ['print', 'rotate', 'yes'],
  // `--id` names which row, and is required once more than one is issued.
  // `--subject`/`--me` say who a new one is for, which is the whole of ADR-068.
  token: ['json'],
  'token list': ['json'],
  'token issue': ['show', 'subject', 'me', 'label'],
  'token show': ['show', 'raw', 'id'],
  // No `--yes`: `tokenRotate` asks nothing, so the flag was accepted and
  // dropped. `--raw` stays and is now read — rotating is the one moment a
  // script most needs the new value, and reading it off decorated output is
  // what `--raw` exists to avoid.
  'token rotate': ['show', 'raw', 'id'],
  'token revoke': ['yes', 'id'],
  // `--subject`/`--me` rather than a positional, so the two commands that name
  // a Lanes subject name it the same way. `--yes` because this ends a live
  // sign-in and will ask before it does.
  session: ['json'],
  'session list': ['json'],
  'session revoke': ['subject', 'me', 'yes'],
  'audit tail': ['limit', 'denied-only', 'format'],
  attach: ['connection'],
  outputs: ['show'],
  start: ['port', 'only'],
  'mcp stdio': ['only'],
  'mcp add': ['name', 'scope', 'token-env', 'dry-run', 'force', 'no-skill', 'headless'],
  // No `--force`: `mcp skill` prints a path or the document and writes nothing,
  // so there was nothing for it to force. It was accepted and ignored, which is
  // the defect `selection.ts` exists to prevent. `mcp add --force` is the flag
  // that replaces a registration.
  'mcp skill': ['print'],
  'mcp list': ['name', 'scope'],
  // `--yes` because it installs the app when nothing answers the scheme, and
  // that is the one prompt in this CLI that puts an application on the machine.
  dashboard: ['print', 'yes'],
  desktop: ['print', 'yes'],
  // No `--force`, for the reason `mcp skill` has none: this prints a path or
  // the document and writes nothing.
  skill: ['print'],
  deploy: ['dry-run', 'iam', 'access', 'service-account', 'tag', 'yes', 'non-interactive'],
  'secrets push': ['from', 'to', 'overwrite', 'dry-run'],
  sync: ['dry-run', 'from', 'discover', 'prefer'],
  'sync targets': ['dry-run', 'from', 'discover', 'prefer'],
  'sync workspaces': ['dry-run', 'from', 'discover', 'prefer'],
  update: ['check'],
  'identity add': ['note'],
  // Each row is exactly what its own file reads, plus what the shared helpers
  // below read for all of them. `memory` listed `--description` and `--file`
  // and `skills` listed `--title` and `--description`; none of the four was
  // read anywhere, and none was ever documented — a memory entry takes its body
  // on stdin and a skill takes its title from its own frontmatter. They were
  // accepted and dropped, which is the half of this defect that leaves no trace
  // at all.
  //
  // `--raw` and `--yes` belong to all six, because the helpers that read them
  // are shared rather than per command: `withRuntime` skips the announce line
  // under `--raw` so `$(…)` captures the value and nothing else, and `agreed`
  // takes `--yes` for every delete. Listing them provider by provider is how
  // `memory forget` came to refuse the flag its own refusal tells you to pass.
  memory: ['connection', 'title', 'tag', 'raw', 'yes'],
  tasks: ['connection', 'title', 'status', 'due', 'tag', 'raw', 'yes'],
  assets: ['connection', 'name', 'content-type', 'raw', 'yes'],
  skills: ['connection', 'file', 'raw', 'yes'],
  // `--show` reveals a value and `--raw` writes it bare. Refusing both left a
  // stored secret with no way out of the CLI at all, under a line that says
  // `--show to reveal`. `--description` is `vault set`'s.
  vault: ['connection', 'show', 'raw', 'description', 'yes'],
  // Its own row because `SELECTION` files `vault key` as needing nothing, so it
  // inherits none of `vault`'s. `vaultKeyGenerate` reads `--raw` itself rather
  // than through `withRuntime`, having no runtime to open.
  'vault key': ['raw'],
  // `alias`, `attr` and `related` are repeatable — see `ownerFlags`. `name`
  // overrides the id derived from the positional name, which is how you get
  // `acme-bv` rather than `acme-b-v`.
  entities: ['connection', 'type', 'name', 'alias', 'attr', 'related', 'tag', 'raw', 'yes'],
  // `no-migrate` is listed beside `migrate` because they are three states
  // rather than two: neither one asks, and a run with no terminal has to be
  // able to say which it meant (ADR-041).
  knowledge: ['repo', 'branch', 'path', 'migrate', 'no-migrate', 'keep', 'allow-public', 'replace', 'yes'],
};

