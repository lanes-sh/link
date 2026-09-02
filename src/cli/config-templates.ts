import { SUPPORTED_CONTRACT } from '#profile';

/**
 * The files a fresh workspace and a fresh profile are written from.
 *
 * Split out of `config-edit.ts` because they are prose rather than machinery:
 * that file knows how to edit YAML without disturbing what an operator wrote,
 * and these are the comments an operator reads. Keeping both in one file put it
 * over the size budget, and the seam was already there.
 *
 * **The template and the repair must write a row in one spelling.** Two
 * spellings of one row is how they drift apart, and `config-edit.test.ts`
 * asserts that a fresh profile and workspace need no repair, which is the check
 * that catches it (ADR-050).
 */

export function newProfileTemplate(profile: string, port: number, subject?: string): string {
  return `# Lanes Link profile: ${profile}
#
# A profile is a *selection*: which of the workspace's accounts this agent may
# reach, what it may do with each, and who may use it. The accounts themselves
# live in connections.yaml beside this file, because authorising an account and
# deciding what may be done with it are two different acts (ADR-057).
#
# This file never contains a credential value — only "_ref" pointers into the
# credential store, which is the workspace's and is encrypted at rest.
#
# Edit it by hand or through the CLI; both are supported, and CLI edits preserve
# your comments and ordering.
contract: 4

instance:
  profile: ${profile}
  port: ${port}
  host: 127.0.0.1

# What this profile is for, in your own words. Members see it, and so does
# setup_overview — "reads my mail, keeps the calendar, never sends" is what
# somebody needs to know before accepting it.
# description: 

# This file says nothing about where it runs, and that is the point.
#
# A profile lives in exactly one workspace, and that workspace declares its own
# adapters, once, in lanes-link.yaml beside the profiles/ directory (ADR-052).
# Moving this profile somewhere else is copying the file there.
#
#     lanes link status --profile ${profile} --workspace <name>
#
# The bearer token below is for CI. People sign in instead: a client that asks
# for authorization is sent to the Lanes login, and comes back as somebody
# (ADR-062). "lanes link token show" is for a runner with no browser.
auth:
  mode: bearer
  token_ref: profile/token
  authorization:
    mode: self

limits:
  requests_per_minute: 120      # per profile
  upstream_calls_per_minute: 60 # per connection, protects vendor quota

# One row per connection this profile may reach, and what it may do with each.
#
# A row is the grant. There is no separate list of accounts and list of rules
# that have to agree — naming a connection here is what makes it reachable, and
# the allow list is what makes any of its capabilities callable. An account the
# workspace holds and this file does not name is simply absent: not denied, not
# advertised, not there.
#
# Rules name capabilities of that row's own provider. "gmail.*" covers
# everything Gmail offers *for that one account*, which is what lets a second
# row over a second mailbox allow something different (ADR-058).
#
# The seven below hold no account, and that is why they are here already: they
# reach your own material rather than anybody's API, so there was never anything
# for a connect step to authorise (ADR-050). What each one is:
#
#   memory   what you want remembered between sessions
#   tasks    what you have to do, each with a status
#   assets   files you want kept, by name
#   skills   procedures you have written, handed to an agent as instructions
#   vault    passwords and API keys, released one at a time
#   setup    what is connected here, and what connecting more would take
#   entities the people, companies and projects you deal with, and how to
#            reach each of them — so an agent looks an address up rather
#            than recalling one
#
# To switch one off, add it to that row's deny — deleting the row no longer
# works, because the next connect or deploy puts it back. The three narrowings
# worth knowing:
#
#   deny: [memory.write]        remember nothing new
#   deny: [skills.manage.*]     invoke procedures, do not write them
#   deny: [vault.put, vault.remove]
grants:
  - { connection: memory.main, allow: [memory.*], deny: [] }
  - { connection: tasks.main, allow: [tasks.*], deny: [] }
  - { connection: assets.main, allow: [assets.*], deny: [] }
  - { connection: skills.main, allow: [skills.*], deny: [] }
  - { connection: vault.main, allow: [vault.*], deny: [] }
  - { connection: setup.main, allow: [setup.*], deny: [] }
  - { connection: entities.main, allow: [entities.*], deny: [] }

# Who may consume this profile (ADR-060).
#
# Empty is nobody, not everybody — default deny on the identity axis. A caller
# proves who they are by signing in to Lanes, and reaches this profile only if
# their subject is listed here.
#
# "owner" may edit this list. Both roles reach exactly what the grants above
# allow: a role that changed what an agent could call would be a second policy
# system beside grants, answering a question the first one already answers.
members:${
    subject
      ? `
  - { subject: ${subject}, role: owner }`
      : ' []'
  }
`;
}

export function newWorkspaceTemplate(): string {
  return `# Lanes Link workspace
#
# A workspace holds the accounts you have authorised (connections.yaml) and the
# profiles that select among them (profiles/). One endpoint serves all of them:
# every call names the profile it means, with --profile.
#
# "workspaces:" below says where this one's bytes go, once, for every profile in
# it — a profile says nothing about where it runs, so there is one copy of it and
# nothing to keep in step (ADR-052).
#
# A workspace somewhere else is a pointer, and "deploy" writes one:
#
#   workspaces:
#     cloud:
#       at: gs://your-bucket
#       lanes_workspace: <id>     # whose members may be delegated to
#
# The workspace at that address declares its own adapters, and is the only thing
# that does. Reading it is a network call, which is why "--workspace cloud" needs
# that bucket reachable.
#
# default_workspace is used when --workspace is absent, and every command that
# uses it prints which one it got. Commands that publish or destroy — deploy,
# sync, secrets push, profile remove, disconnect, token rotate — refuse it and
# make you type the name (ADR-061).
contract: 4
default_workspace: local
workspaces:
  local:
    credentials: { adapter: file }
    storage: { adapter: filesystem }
`;
}

/**
 * `connections.yaml` for a workspace that has just been created.
 *
 * The owner layer arrives here rather than in the profile, because these are
 * connections now (ADR-059) and a second profile should select the same stores
 * rather than get its own empty ones. `ensureOwnerLayer` keeps this in one
 * spelling with the repair, which `config-edit.test.ts` asserts by checking that
 * a fresh workspace needs no repair.
 */
export function newConnectionsTemplate(): string {
  return `# Lanes Link connections
#
# Every account authorised in this workspace, in one place. A profile names the
# ones it may reach in its own "grants:" block — connecting an account and
# deciding what may be done with it are two acts, and only the second belongs to
# a profile (ADR-057).
#
# "account" is the identity the provider reports — an address, a workspace — so
# this list says whose data is reachable without having to look anything up.
# "label" is your own word for the same row, and only ever displayed.
#
# The seven below hold no account: they reach your own material rather than
# anybody's API, so there was never anything for a connect step to authorise
# (ADR-050). Make a second one — "lanes link connect memory --id work" — when you
# want two profiles to share nothing.
contract: 4

connections:
  - { id: main, provider: memory, account: Memory }
  - { id: main, provider: tasks, account: Tasks }
  - { id: main, provider: assets, account: Assets }
  - { id: main, provider: skills, account: Skills }
  - { id: main, provider: vault, account: Vault }
  - { id: main, provider: setup, account: Setup }
  - { id: main, provider: entities, account: Entities }

# App registrations, shared by every connection of that vendor.
oauth_apps: {}
`;
}

