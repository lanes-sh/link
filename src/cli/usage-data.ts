/**
 * Every command and flag this CLI documents, as data.
 *
 * Split from `usage.ts` on the seam the file-size budget pointed at, and it is a
 * real one rather than an arithmetic one: this file changes when a command is
 * added, and the renderer beside it changes when the layout does. Neither has
 * ever been a reason to open the other.
 *
 * It is also the file `src/cli/contract3-data.ts` and `contract4-data.ts` are
 * named after — a data literal whose length is a count of what this tool does,
 * not a count of what it is responsible for.
 */

export interface Entry {
  /** Spelled without `PROGRAM`, which the renderer puts back. */
  readonly command: string;
  readonly description?: string;
  /** A bare flag rather than a command, so `PROGRAM` is not prefixed. */
  readonly flag?: boolean;
  /**
   * Start a new group, with a blank line before it.
   *
   * `Your own context` is seven surfaces — memory, tasks, assets, skills,
   * entities, knowledge, vault — and the template literal separated them with
   * blank lines it could spell and this shape could not. Forty entries in one
   * run is a list nobody reads to the end of.
   */
  readonly gap?: boolean;
}

export interface Section {
  readonly title: string;
  readonly entries: readonly Entry[];
}

export const SECTIONS: readonly Section[] = [
  {
    title: 'Everyday',
    entries: [
      {
        command: 'setup plan [--json]',
        description: 'what each provider needs, and which are connected',
      },
      {
        command: 'setup plan <provider>',
        description: 'the console steps, the values, and the command',
      },
      {
        command: 'connect <provider>',
        description: 'authorise an account into this workspace (once per account, not once per profile)',
      },
      { command: 'connect <provider>.<id>', description: 're-authorise one existing account' },
      {
        command: 'connect <...> --replace',
        description: 'ask for the stored password or key again',
      },
      {
        command: 'connect <...> --auth <method>',
        description: 'pick how, where there is a choice',
      },
      {
        command: 'connect <...> --non-interactive [--json]',
        description: 'answer nothing from a terminal: take every value from the credential store, or say what is missing',
      },
      {
        command: 'disconnect <provider>.<id>',
        description: 'remove an account, and delete its credential',
      },
      {
        command: 'disconnect <...> --keep-credential',
        description: 'leave the credential in the store',
      },
      {
        command: 'relabel <provider>.<id> <name>',
        description: 'rename what an account is called',
      },
      {
        command: 'connect custom <id> --connector <kind> --auth <method>',
        description: 'declare a service that is not built in, and connect it. kinds: mcp, http, imap, dav, fs. Omit a value and it is asked for; the manifest it writes is yours to edit',
      },
      {
        command: 'connection list [--json]',
        description: 'every account in this workspace, and who grants it',
      },
      {
        command: 'grant add <provider>.<id>',
        description: 'let a profile reach one, with nothing allowed yet',
      },
      { command: 'grant remove <provider>.<id>' },
      {
        command: 'start [--only]',
        description: 'reconcile and serve every profile on one endpoint',
      },
      { command: 'outputs [--show] [--json]', description: 'the endpoint an agent needs' },
      {
        command: 'desktop [--print] [--yes]',
        description: 'open the Lanes app on its Lanes Link page, installing it first if it is not there',
      },
      { command: 'dashboard', description: 'the older spelling of the line above' },
      {
        command: 'mcp add [claude|codex]',
        description: 'register this endpoint, and install the agent skill',
      },
      {
        command: 'mcp add --no-skill',
        description: "register only, leaving the agent's own files alone",
      },
      {
        command: 'mcp list',
        description: 'where it is registered, and whether the skill is current',
      },
      { command: 'mcp stdio', description: 'serve on stdin/stdout, for a client that spawns it' },
      {
        command: 'mcp skill [--print]',
        description: 'the bundled skill — its path, or the document itself',
      },
      {
        command: 'mcp install-instructions [--client claude|chatgpt|codex|cursor]',
        description: 'a block to paste where a client keeps its own standing instructions, so it knows to look here',
      },
      {
        command: 'pair [--print] [--rotate]',
        description: 'let the Lanes dashboard read this machine',
      },
      { command: 'status [--json]', description: 'connections, reachable capabilities, endpoint' },
    ],
  },
  {
    title: 'Profiles',
    entries: [
      {
        command: 'profile add <name> --workspace <name> [--workspace <name>] [--json]',
        description: 'a target per place it runs; local is derived, the rest are copied from a sibling profile',
      },
      { command: 'profile list [--json]' },
      {
        command: 'profile remove <name> [--workspace <name>] [--dry-run] [--yes] [--json] [--delete-data | --migrate-to <profile>]',
        description: 'Say which of --delete-data or --migrate-to for its memory, tasks, assets and skills — there is no default. Accounts outlive it; disconnect removes those, and token revoke the tokens.',
      },
    ],
  },
  {
    title: 'Workspaces',
    entries: [
      { command: 'workspace list [--urls]', description: 'every workspace this one knows' },
      {
        command: 'workspace show <name>',
        description: "one workspace's adapters, and its address",
      },
      {
        command: 'sync workspaces --workspace <name> [--from gs://bucket] [--discover] [--prefer local|remote] [--dry-run]',
        description: 'reconcile this workspace with the copy the deployment reads; recovers one a profile has lost',
      },
    ],
  },
  {
    title: 'Who you are',
    entries: [
      {
        command: 'identity add <kind> <value> [--note text] [--json]',
        description: 'e.g. name, email, github — any kind you like',
      },
      { command: 'identity list [--json]' },
      { command: 'identity remove <kind> <value> [--json]' },
    ],
  },
  {
    title: 'Permissions',
    entries: [
      { command: 'policy list' },
      {
        command: 'policy allow <capability> --connection <provider>.<id>',
        description: 'e.g. gmail.* or gmail.send_message. A rule lands in one grant, so two accounts can differ',
      },
      { command: 'policy deny  <capability> --connection <provider>.<id>' },
      {
        command: 'profile members list',
        description: 'who may consume this profile, and who could',
      },
      { command: 'profile members add <subject>|--me [--role owner|member]' },
      { command: 'profile members remove <subject>' },
      { command: 'token list [--json]', description: 'static tokens, and what each one reaches' },
      {
        command: 'token issue --me|--subject <id> [--label <t>]',
        description: 'CI only: a token for one person. It reaches every profile whose members list them',
      },
      {
        command: 'token show [--id t] [--show|--raw]',
        description: '--raw prints only it, for $(…)',
      },
      { command: 'token rotate [--id t] [--show]' },
      { command: 'token revoke --id <t>' },
    ],
  },
  {
    title: 'Your own context',
    entries: [
      { command: 'memory list [--tag t]', description: 'what you have stored' },
      { command: 'memory get <id>' },
      { command: 'memory write <id> --title <t> [--tag t]', description: 'body on stdin' },
      { command: 'memory forget <id>' },
      {
        gap: true,
        command: 'tasks list [--status s]',
        description: 'what is outstanding; --status all for everything',
      },
      { command: 'tasks get <id>' },
      {
        command: 'tasks add <title> [--status s] [--due d] [--tag t]',
        description: 'notes on stdin',
      },
      {
        command: 'tasks update <id> --status <s>',
        description: 'closing one is an update, not a remove',
      },
      {
        command: 'tasks remove <id>',
        description: 'statuses: in_progress open blocked muted done dropped',
      },
      { gap: true, command: 'assets list', description: 'files kept in this profile' },
      { command: 'assets get <name>', description: 'the bytes, to stdout — redirect them' },
      { command: 'assets add <file> [--name n] [--content-type t]' },
      { command: 'assets remove <name>' },
      { gap: true, command: 'skills list', description: 'the procedures agents can invoke' },
      { command: 'skills show <name>' },
      { command: 'skills add <name> [--file f]', description: 'document on stdin' },
      { command: 'skills remove <name>' },
      { gap: true, command: 'entities', description: 'who and what everyone else is' },
      {
        command: 'entities find [query] [--type t] [--tag t] [--attr kind[=value]] [--related predicate=id]',
        description: 'every match, never a choice',
      },
      { command: 'entities get <id>', description: 'with its relationships, both ways' },
      {
        command: 'entities write <name> [--type t] [--name id] [--alias a] [--attr kind=value] [--related predicate=id]',
        description: 'notes on stdin; a flag you omit keeps what is stored',
      },
      {
        command: 'entities link <from> <predicate>=<to>',
        description: 'one edge, written on <from> only',
      },
      { command: 'entities forget <id>' },
      { command: 'entities reindex', description: 'rebuild the lookup index from the files' },
      { gap: true, command: 'knowledge show', description: 'where memory and skills are kept, and how many' },
      {
        command: 'knowledge use github --repo <owner/name> [--branch b] [--path p]',
        description: 'keep both in a private repository, over the GitHub API [--migrate] moves what is already stored, in one commit [--no-migrate] switches and leaves it where it is [--keep] moves it, and leaves the local copies unread',
      },
      {
        command: 'knowledge use local [--migrate]',
        description: 'bring them back onto this target',
      },
      { gap: true, command: 'vault list', description: 'names only, never values' },
      { command: 'vault get <id> [--show|--raw]' },
      { command: 'vault set <id> [--description d]', description: 'value on stdin' },
      { command: 'vault remove <id>' },
      { command: 'vault key generate', description: 'a fresh LANES_LINK_VAULT_KEY, printed once' },
    ],
  },
  {
    title: 'Deploying',
    entries: [
      {
        command: 'deploy --workspace <name> [--dry-run]',
        description: 'set up, build, and roll one revision serving every profile that declares the target',
      },
      {
        command: 'deploy --workspace <name> --profile a --profile b',
        description: 'only these; the first is the primary',
      },
      { command: 'deploy --non-interactive', description: 'take the stored answers, never prompt' },
      {
        command: 'deploy --access iam|public',
        description: "who gets past the platform's own door",
      },
      { command: 'secrets list', description: 'credential references in this target' },
      { command: 'secrets set <ref>', description: 'store one value, read from stdin' },
      { command: 'secrets push --from local --to cloud' },
    ],
  },
  {
    title: 'Inspection',
    entries: [
      { command: 'check', description: 'static validation, no external calls' },
      { command: 'doctor [--json]', description: 'credentials resolve, stores reachable' },
      {
        command: 'doctor --fix',
        description: 'apply a repair it can make itself, such as a provider this project renamed under you',
      },
      { command: 'auth [--json]', description: 'whether each connection can still sign in' },
      { command: 'auth --connection <key>', description: 'just this one' },
      { command: 'tools [--json]', description: 'what the endpoint advertises to a client' },
      { command: 'plan', description: 'what reconcile would change' },
      { command: 'audit tail [--limit N] [--denied-only] [--format md]' },
      { command: 'audit verify', description: 'has anything in the log been altered or removed' },
      { command: 'config show' },
      { command: 'version', description: 'which release this is — same as lanes --version' },
      {
        command: 'update [--check] [--json]',
        description: 'install the newer release, or say what is available',
      },
    ],
  },
  {
    title: 'Attachments',
    entries: [
      {
        command: 'attach <file> --connection <provider>.<account>',
        description: 'stage a file, print a handle to send it by',
      },
    ],
  },
  {
    title: 'Naming what a command acts on',
    entries: [
      {
        command: '--profile <name>',
        description: 'required by every command that reads or writes a profile',
        flag: true,
      },
      {
        command: '--workspace <name>',
        description: "required by every command that opens a workspace's stores. \"lanes set-workspace <name>\" writes a default; every command that uses it prints the name it resolved, and deploy, sync, secrets push, profile remove, disconnect and token rotate refuse it and want the flag.",
        flag: true,
      },
      {
        command: '--target <name>',
        description: 'the old spelling of --workspace. Accepted for one minor, and it warns.',
        flag: true,
      },
    ],
  },
  {
    title: 'Other flags',
    entries: [
      {
        command: '--connection <id>',
        description: 'which memory/tasks/assets/skills/vault/entities connection, where a profile has several of one kind',
        flag: true,
      },
      {
        command: '--yes',
        description: 'skip the confirmation a destructive command would ask for',
        flag: true,
      },
      {
        command: '--json',
        description: 'machine-readable output, where a command offers it',
        flag: true,
      },
      {
        command: '--non-interactive',
        description: 'never prompt: connect refuses with what to store, deploy takes the answers its config already holds',
        flag: true,
      },
      {
        command: '--label <text>',
        description: 'what to call a connection, instead of being asked at the end of connect. A display name only: nothing addresses a connection by it. Use relabel to change one later',
        flag: true,
      },
      {
        command: '--accept-broad-scopes',
        description: 'agree in advance to scopes broader than a provider needs',
        flag: true,
      },
      {
        command: '--own-client',
        description: 'register your own OAuth client instead of using the one this project operates (connect only)',
        flag: true,
      },
      {
        command: '--auth <method>',
        description: 'which way in, where a provider offers two (connect only). "oauth" is the browser; the other is named in the choice connect prints. On connect custom it names the credential type instead: none, bearer, api-key, header, basic, oauth, strategy',
        flag: true,
      },
      {
        command: '--replace-manifest',
        description: 'rewrite a declaration that already exists and differs (connect custom only — --replace is about the credential)',
        flag: true,
      },
      {
        command: '--port <n>',
        description: 'override the configured port (start only)',
        flag: true,
      },
    ],
  },
];
