import { style } from './output.ts';

/**
 * The help text, and the name the CLI calls itself.
 *
 * `PROGRAM` is a constant rather than 59 string literals because it had been 59
 * string literals: the rename that produced `lanes link` meant editing the
 * usage text, every `Usage:` line, and every `Unknown:` line by hand, with no
 * way to tell from a green test suite whether one had been missed. The next
 * rename touches this line, and `argv.test.ts` holds the two to each other.
 *
 * The text lives here rather than in `main.ts` because it is 65 lines of prose
 * that changes for entirely different reasons from the dispatch below it.
 */

/** How this CLI is invoked — the `link` area of the `lanes` command. */
export const PROGRAM = 'lanes link';

export const USAGE = `${style.bold(PROGRAM)} — a self-hostable MCP gateway for all your connections, memory, skills, and secrets

${style.bold('Everyday')}
  ${PROGRAM} setup plan [--json]        what each provider needs, and which are connected
  ${PROGRAM} setup plan <provider>      the console steps, the values, and the command
  ${PROGRAM} connect <provider>         add an account (run once per account)
  ${PROGRAM} connect <provider>.<id>    re-authorise one existing account
  ${PROGRAM} connect <...> --replace    ask for the stored password or key again
  ${PROGRAM} connect <...> --auth <method>  pick how, where there is a choice
  ${PROGRAM} connect <...> --non-interactive [--json]
                                        answer nothing from a terminal: take every value
                                        from the credential store, or say what is missing
  ${PROGRAM} start [--only]             reconcile and serve every profile on one endpoint
  ${PROGRAM} outputs [--show] [--json]  the endpoint an agent needs
  ${PROGRAM} dashboard [--print]        open the local endpoint's page in a browser
  ${PROGRAM} mcp add [claude|codex]     register this endpoint, and install the agent skill
  ${PROGRAM} mcp add --no-skill         register only, leaving the agent's own files alone
  ${PROGRAM} mcp list                   where it is registered, and whether the skill is current
  ${PROGRAM} mcp stdio                  serve on stdin/stdout, for a client that spawns it
  ${PROGRAM} mcp skill [--print]        the bundled skill — its path, or the document itself
  ${PROGRAM} status [--json]            connections, reachable capabilities, endpoint

${style.bold('Profiles')}
  ${PROGRAM} profile add <name> --target <name> [--target <name>] [--json]
                                 a target per place it runs; local is derived, the
                                 rest are copied from a sibling profile
  ${PROGRAM} profile list [--json]
  ${PROGRAM} profile remove <name> [--target t] [--dry-run] [--yes] [--json]
                                 the profile, its credentials, and its data

${style.bold('Targets')}
  ${PROGRAM} target list [--urls]      where this profile can run
  ${PROGRAM} target show <name>        one target's adapters, and the address it answers on

${style.bold('Who you are')}
  ${PROGRAM} identity add <kind> <value> [--note text] [--json]
                                 e.g. name, email, github — any kind you like
  ${PROGRAM} identity list [--json]
  ${PROGRAM} identity remove <kind> <value> [--json]

${style.bold('Permissions')}
  ${PROGRAM} policy list
  ${PROGRAM} policy allow <capability>  e.g. gmail.* or gmail.send_message
  ${PROGRAM} policy deny  <capability>
  ${PROGRAM} token show [--show|--raw]  --raw prints only the token, for $(…)
  ${PROGRAM} token rotate [--show]

${style.bold('Your own context')}
  ${PROGRAM} memory list [--tag t]      what you have stored
  ${PROGRAM} memory get <id>
  ${PROGRAM} memory write <id> --title <t> [--tag t]   body on stdin
  ${PROGRAM} memory forget <id>

  ${PROGRAM} skills list                the procedures agents can invoke
  ${PROGRAM} skills show <name>
  ${PROGRAM} skills add <name> [--file f]             document on stdin
  ${PROGRAM} skills remove <name>

  ${PROGRAM} vault list                 names only, never values
  ${PROGRAM} vault get <id> [--show|--raw]
  ${PROGRAM} vault set <id> [--description d]         value on stdin
  ${PROGRAM} vault remove <id>
  ${PROGRAM} vault key generate         a fresh LANES_LINK_VAULT_KEY, printed once

${style.bold('Deploying')}
  ${PROGRAM} deploy [--dry-run]         set up, build, and roll a revision
  ${PROGRAM} deploy --non-interactive   take the stored answers, never prompt
  ${PROGRAM} deploy --access iam|public who gets past the platform's own door
  ${PROGRAM} deploy --target <name>     deploy a second one, under its own name
  ${PROGRAM} secrets list               credential references in this target
  ${PROGRAM} secrets set <ref>          store one value, read from stdin
  ${PROGRAM} secrets push --from local --to cloud

${style.bold('Inspection')}
  ${PROGRAM} check                      static validation, no external calls
  ${PROGRAM} doctor [--json]            credentials resolve, stores reachable
  ${PROGRAM} tools [--json]             what the endpoint advertises to a client
  ${PROGRAM} plan                       what reconcile would change
  ${PROGRAM} audit tail [--limit N] [--denied-only] [--format md]
  ${PROGRAM} audit verify           has anything in the log been altered or removed
  ${PROGRAM} config show
  ${PROGRAM} version                    which release this is — same as lanes --version
  ${PROGRAM} update [--check] [--json]  install the newer release, or say what is available

${style.bold('Attachments')}
  ${PROGRAM} attach <file> --connection <provider>.<account>
                                        stage a file, print a handle to send it by

${style.bold('Naming what a command acts on')}
  --profile <name>               required by every command that reads or writes a profile
  --target <name>                required by every command that opens a target's stores.
                                 There is no default and no environment variable: a
                                 command that names neither refuses and lists what exists.

${style.bold('Other flags')}
  --connection <id>              which memory/skills/vault connection, if a profile has several
  --yes                          skip the confirmation a destructive command would ask for
  --json                         machine-readable output, where a command offers it
  --non-interactive              never prompt: connect refuses with what to store,
                                 deploy takes the answers its config already holds
  --accept-broad-scopes          agree in advance to scopes broader than a provider needs
  --own-client                   register your own OAuth client instead of using the
                                 one this project operates (connect only)
  --auth <method>                which way in, where a provider offers two (connect
                                 only). "oauth" is the browser; the other is named
                                 in the choice connect prints
  --port <n>                     override the configured port (start only)

Every command prints the profile and target it is acting on, before it acts.
`;
