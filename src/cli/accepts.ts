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
  // A filter, not a second subject: it narrows the answer to one connection so
  // a caller can re-ask about the row it just repaired. Same shape as `attach`.
  auth: ['connection'],
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
  'token show': ['show', 'raw'],
  'token rotate': ['show', 'raw', 'yes'],
  'audit tail': ['limit', 'denied-only', 'format'],
  'audit verify': ['limit', 'format'],
  attach: ['connection'],
  outputs: ['show'],
  start: ['port', 'only'],
  'mcp stdio': ['only'],
  'mcp add': ['name', 'scope', 'token-env', 'dry-run', 'force', 'no-skill', 'headless'],
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
  'sync workspaces': ['dry-run', 'from', 'discover', 'prefer'],
  update: ['check'],
  'identity add': ['note'],
  memory: ['connection', 'title', 'description', 'file', 'tag'],
  // `--yes` on both, because both have a delete that asks first.
  tasks: ['connection', 'title', 'status', 'due', 'tag', 'yes'],
  assets: ['connection', 'name', 'content-type', 'yes'],
  skills: ['connection', 'title', 'description', 'file'],
  vault: ['connection'],
  // `alias`, `attr` and `related` are repeatable — see `ownerFlags`. `name`
  // overrides the id derived from the positional name, which is how you get
  // `acme-bv` rather than `acme-b-v`.
  entities: ['connection', 'type', 'name', 'alias', 'attr', 'related', 'tag', 'yes'],
  // `no-migrate` is listed beside `migrate` because they are three states
  // rather than two: neither one asks, and a run with no terminal has to be
  // able to say which it meant (ADR-041).
  knowledge: ['repo', 'branch', 'path', 'migrate', 'no-migrate', 'keep', 'allow-public', 'replace', 'yes'],
};

