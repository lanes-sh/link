# Configuration

One profile = one config file = one blob store = one credential store. One endpoint serves them all.

```
lanes-link.yaml          workspace settings: contract
profiles/
  personal.yaml
  work.yaml
data/                   everything each profile owns, gitignored
  personal/
    state.kv/           connections, provider state, cursors
    audit.log/          one object per event
    credentials.enc     system credentials, and its .key
    vault.enc           the owner's items, its own key
    skills.d/           procedures, one <name>/SKILL.md each
    providers.d/        your own provider manifests
    <provider>/<connection>/…
  work/
    …
```

A real config is gitignored; only `*.example.yaml` is committed.

Nothing under `data/` is shared. Skills and provider manifests used to sit at the workspace root
where every profile read them; [ADR-030](adr/030-a-profile-owns-its-skills-and-manifests.md) moved
both into the profile that owns them. Two consequences worth knowing:

- **A skill or manifest left at the old `skills/` or `providers/` loads for nobody.** There is no
  migration. Move each one into the profile that should have it — `mv skills/review-diff
  data/personal/skills.d/` — and delete what is left.
- **`data/` is gitignored, so skills are no longer committable where they sit.** If you keep
  procedures in version control, keep them in their own repository and copy them in. Un-ignoring a
  path inside `data/` is not worth it: the directory beside them holds an encrypted credential
  store and the key that opens it.

## A complete profile

```yaml
contract: 2

instance:
  profile: personal
  port: 7337
  host: 127.0.0.1

# It says nothing about where it runs, and that is the point. A profile lives in
# exactly one target, and the target is the workspace holding this file — which
# declares its adapters once, in lanes-link.yaml beside profiles/ (ADR-052).

# The bearer token for the endpoint this profile serves. One "lanes link start"
# serves every profile in the workspace from one URL, and this token opens it —
# so it admits all of them, not only this profile.
auth:
  mode: bearer
  token_ref: profile/token
  # Browser origins allowed to call /mcp. Absent means "*", so this is only
  # worth setting to narrow it. Deployment only — a loopback endpoint refuses
  # every cross-origin request, and this cannot widen that. ADR-039.
  allowed_origins: ['*']

limits:
  requests_per_minute: 120        # per profile
  upstream_calls_per_minute: 60   # per connection, protects vendor quota

# App registrations, shared by every connection of that vendor.
#
# Also the switch. A provider whose manifest names a broker — every Google REST
# provider does — authorises against the client that broker operates when there
# is no entry here, and against yours when there is. Written for you by
# "lanes link connect <provider> --own-client". Deleting it is not enough to go
# back: the client is also looked for in the credential store, so that a profile
# whose config lost this block is not silently moved onto a different client and
# left holding refresh tokens the new one refuses. Removing both is what
# switches — see the lifecycle section below.
oauth_apps:
  google:
    client_id_ref: google/client_id
    client_secret_ref: google/client_secret

# One entry per authorised account. "account" is the identity the provider
# reports, resolved at connect time — so this list answers "whose mailbox is
# this" without a lookup. The id derives from it and is not usually written.
#
# Where the credential lives is the provider's answer, not this file's: an
# optional "credential_ref" here adds a secret the connection may reach, and
# does not move the one it authenticates with.
#
# The six with no account are the owner layer, and a profile is created with
# them already declared — they reach your own material, so there was never
# anything for a connect step to authorise (ADR-050).
connections:
  - { id: main, provider: memory, account: Memory }
  - { id: main, provider: tasks, account: Tasks }
  - { id: main, provider: assets, account: Assets }
  - { id: main, provider: skills, account: Skills }
  - { id: main, provider: vault, account: Vault }
  - { id: main, provider: setup, account: Setup }
  - id: ada_lovelace
    provider: gmail
    account: ada.lovelace@example.com
  - id: rin_shaw
    provider: gmail
    account: rin.shaw@example.com

# Only what is listed here is reachable, and an empty policy grants nothing.
# A deny always beats an allow, and it is how an owner-layer surface is
# switched off — deleting its connection row does not, because the next start,
# connect or deploy writes it back.
policy:
  allow: ['*']
  deny:  [gmail.users.drafts.send]

# Optional. Who the owner is, for anything written as them — a name to sign
# with, an address to send from, a handle to attribute to. Order is the
# ranking: the first of a kind is the default, and the note says when to
# prefer another.
identity:
  - { kind: name,   value: Ada,         note: use for open-source work }
  - { kind: name,   value: A. Lovelace, note: use on anything published }
  - { kind: email,  value: ada.lovelace@example.com }
  - { kind: github, value: octocat }
```

There is no `providers` block: declaring a connection is what enables a provider, and a second
place to say so could only ever disagree with the first.

## Config never contains a credential

Only `_ref` pointers into the credential store. This is enforced, not merely intended: the loader
rejects private key blocks, known vendor prefixes (`sk-`, `xoxb-`, `ya29.`, `ghp_`, …), high-entropy
blobs, and any key naming a credential that holds a literal instead of a `_ref` — naming the exact
path:

```
personal.yaml: Configuration must not contain credential values, only "_ref" pointers.
This value looked like a credential:
  oauth_apps.google.client_secret starts with "ya29.", which identifies a Google OAuth access token
```

There is deliberately no suppression flag.

## Identity

`kind` is any lowercase identifier, so `name`, `email` and `github` are conventions rather than a
list this project ships — `linkedin`, `phone`, `pronouns` and `signature` need no code change.
`value` is the name or address. `note` is prose, read by whatever is writing as you.

Declare one through the CLI rather than by hand, because the block on its own is inert:

```console
$ lanes link identity add name "A. Lovelace" --note "use on anything published" --profile personal --target local
$ lanes link identity add email ada.lovelace@example.com --profile personal --target local
$ lanes link identity list --profile personal
```

The first of those writes three things: the entry, a `connections` row for the `identity`
provider, and an `identity.*` allow rule. All three are needed before anything can read it — a
provider with no connection row is filtered out before policy is consulted, so an `identity`
block by itself is a file that says exactly what you meant and an agent that cannot see a word of
it. `identity list` says `declared, but no agent can read it` when that is the state.

What reads it is one read-only tool, `identity_list`. Nothing on the MCP surface can write here:
an agent able to edit this could edit the one fact that stops it signing as the wrong person, so
editing is CLI-only under ADR-007. The endpoint's own instructions carry a pointer to the tool and
none of the values — see [ADR-042](adr/042-a-profile-declares-who-its-owner-is.md).

Removing the last entry leaves the row and the rule in place, and the tool then reports that
nothing is declared.

## A profile that uses the hosted OAuth client

The default, and the shorter file: there is no `oauth_apps` block at all, because there is no client
to point at. The Google connections below authorise against the client Lanes operates, and its
secret is never on this machine.

```yaml
contract: 2

instance:
  profile: personal

connections:
  - id: ada_lovelace
    provider: gmail
    account: ada.lovelace@example.com

policy:
  allow: ['gmail.*']
```

Adding an `oauth_apps` entry later does not move an existing connection onto your client: which
client minted a refresh token is recorded with the token, because one client's refresh token is
refused by another. Run `connect` again for any connection you want moved. See
[ADR-028](adr/028-a-hosted-oauth-client-is-the-default.md).

## Removing a profile

```console
$ lanes link profile remove work --profile personal
```

It prints what it would delete, then asks you to type the profile name. `--dry-run` stops after the
preview, `--yes` skips the prompt, and `--target <name>` decommissions one target while leaving the
profile itself in place.

What goes: the profile's config, and — in **every target it declares** — its credentials, state,
audit log, provider blobs, vault, skills, and provider manifests. For a target whose home is a
bucket, the copy of the config a deployed revision reads goes too.

Skills and manifests go because they are inside the profile's own directory
([ADR-030](adr/030-a-profile-owns-its-skills-and-manifests.md)); before that they were shared and
this command left them alone. Nothing another profile can see is deleted.

What stays, and each for a reason:

- **`lanes-link.yaml`.** If it still names this profile as the inert `default_profile`, that key is cleared rather
  than repointed at whatever remains — choosing a new default would silently change what every
  other command in the workspace acts on.
- **Infrastructure.** No Cloud Run service, bucket, or service account is touched. `deploy` created
  those and can recreate them; removing them needs permissions this command should not hold.
- **Credentials this profile does not declare.** In Secret Manager, references are flat names in
  one project, so two profiles deployed to the same project share a namespace. Only what this
  profile declares is deleted; anything else is listed in the preview and left alone.

Removal is best effort. If a store cannot be reached — a project deleted, an expired login — the
rest still goes, every survivor is named with the command that finishes it, and the exit code is
non-zero. The profile's config is **kept** in that case, so nothing is stranded and the retry is the
same command again.

A deployed target is called out in the preview: the service keeps answering, and every call fails,
because what it served is gone.

### Going back to the hosted OAuth client

This is the blunt instrument for it. The precise one is to remove the `oauth_apps` entry *and* the
stored `google/client_id` and `google/client_secret` — both, because the client is looked for in the
credential store as well as in config. Then run `connect` again for each account: a refresh token is
only accepted by the client that minted it.

## Validation rules

1. **An unknown contract major fails closed.** Never a best-effort load — this file governs
   authorization, and guessing at a schema we do not implement risks reading it as more permissive
   than it was written.
2. **Credential-shaped values are rejected**, with the offending path named.
3. **`_ref` values must be well-formed.** Existence is checked by `lanes link doctor`, not the loader, so an
   unconnected account does not block startup.
4. **Ids are unique per provider.** `gmail.main` and `icloud_mail.main` coexist.
5. **An `allow` rule naming a provider with no connection fails**, because a rule that silently
   grants nothing looks identical to a working one. A `deny` may name one: withholding something
   ahead of connecting it is reasonable, and refusing that would punish the cautious ordering.
7. **`--target` must name a declared target.** `instance.default_target` is no longer read or validated (ADR-037).
8. **A CLI write validates before writing**, and never leaves the file invalid on failure.

## Policy grammar

```yaml
policy:
  allow:
    - '*'                              # everything, which is what connect writes
    - gmail.*                          # one provider
    - gmail.users.labels.list          # one capability
  deny:
    - gmail.users.drafts.send
```

Three forms and no more. `gmail.*` matches `gmail.search` but not `gmailx.search` — the dot is part
of the prefix. `gmail.*.read` and `gm*` are rejected. There is no policy expression language,
deliberately: every additional operator is another way to believe you wrote something narrower than
you did.

**Rules name capabilities, never connections.** Every account of a provider within a profile is
governed identically — `gmail.*` covers both mailboxes above. Granting two accounts differently
means a second profile, which shares no state, no log, and no credential store with the first.

A **deny beats an allow regardless of order in the file**, including the catch-all `'*'` that
`connect` writes. For an expiry, a rule may take its object form instead:

```yaml
    - { capability: gmail.*, expires_at: "2027-01-01T00:00:00Z" }
```

## Targets

A target names an adapter set — and it is declared by a **workspace**, not by a profile (ADR-052).
A workspace *is* a target: it holds the profiles that live in it, and says once, in its own
`lanes-link.yaml`, where their bytes go.

```yaml
# ~/.lanes-link/lanes-link.yaml
contract: 2

targets:
  local:                            # this workspace is the "local" target
    credentials: { adapter: file }
    storage: { adapter: filesystem }
  cloud:
    workspace: gs://your-bucket     # a pointer; that workspace declares it
```

An entry is either a **declaration** — `credentials` and `storage`, and whatever else the adapter
set needs — or a **pointer**, carrying `workspace:` and nothing else. Both is refused: two answers
to "where do this target's bytes go" is the state that let a rewritten profile report seven
connections for a bucket holding fifteen.

Following a pointer is a read of that workspace's own file, so `--target cloud` needs the bucket
reachable. Offline it says so, rather than answering from a local copy that may be hours stale.

### What a deploy writes back

`lanes link deploy` stamps three fields onto the entry, on **both** ends — the target's own
workspace file and the pointer here:

```yaml
contract: 2

targets:
  cloud:
    workspace: gs://your-bucket
    primary: personal                              # whose token opens the endpoint (ADR-009)
    last_deploy: "2026-08-28T09:00:00.000Z"
    last_deploy_version: "0.6.6"                   # the release that rolled the revision
```

`last_deploy_version` is the CLI release that ran the deploy, which is the code the endpoint is
running: the image is built from the installed package, so the two cannot differ. It is written
*after* the rollout, so a build that failed leaves the previous version in place rather than
claiming one that never served a request.

Keeping it on the pointer as well as in the bucket is what makes it readable offline —
`lanes link target list` deliberately follows no pointer, and `lanes link target show <name>` prints
it beside `last_deploy`. Nothing reads these three; they are a record, and every command works
without them.

| Interface | `local` | `cloud` |
|---|---|---|
| SecretStore | encrypted file | Google Secret Manager |
| BlobStore | filesystem | `gcs`, or any S3-compatible bucket |
| VaultStore | encrypted file | Google Secret Manager, one sealed entry |

**Two adapters, and that is the whole of the difference.** There is no `database:` block: runtime
state is one object per key in the same `BlobStore`, and the audit log is one object per event
beside it (ADR-020). A profile written before that keeps its `database:` key and it is ignored.

Credentials follow the target, because each target has its own credential store.

### More than one deployment

`local` and `cloud` are conventions, not keywords — nothing reserves either name, and a workspace
may know as many targets as it has places to reach. A second deployment is named on the deploy that
creates it (`lanes link deploy --target staging`), which surveys for what it does not know, writes
the declaration into the workspace it creates, and leaves a pointer here.

`lanes link target list` prints the registry without following any pointer, so it is instant and
works offline; `lanes link target show <name>` follows one and reports what is really there.
`lanes link target use` has been removed (ADR-037) — name the target on each command.

A profile lives in exactly one target. `personal` on `local` and `personal` on `cloud` are two
files, in two workspaces, that happen to share a name — which is why every command names both.

Each target's credential store is its own, so a connection authorised against `cloud` is absent from
`staging` — `lanes link secrets push --from cloud --to staging` copies them across instead of
re-running every consent.

Two cloud blob adapters, and the difference is setup rather than capability. `gcs` authenticates
as the identity already present — the service account `lanes link deploy` grants `objectAdmin`, or
your own gcloud credentials locally — so the bucket needs **no credential of its own**. `s3` needs
an endpoint and an HMAC key pair, which on GCS means a console visit to mint one; it is the answer
for R2, MinIO, Supabase Storage, and AWS.
**`BlobStore` is not optional in the cloud** — state, the log, memory, tasks, assets, and skills all
live in it, and a container filesystem loses every one of them on an instance recycle without
reporting anything.

### The vault block

Optional, and defaulting to `file`, so a profile that predates it keeps working and a local run needs
no vault configuration at all:

```yaml
# in that workspace's lanes-link.yaml
targets:
  cloud:
    vault: { adapter: blob }      # the target's own storage; key defaults to vault.enc
```

The `blob` adapter **requires `LANES_LINK_VAULT_KEY`** and will not mint a key. The file adapter may,
because it writes one to a sibling `<path>.key` at mode 0600 that outlives the process; a deployment
has no equivalent, and a key generated per revision would make every stored item permanently
unreadable while appearing to work. Mint one with `lanes link vault key generate`.

### The knowledge block

Optional, and absent by default. It moves **memory entries and skills** into a GitHub repository,
reached over the API, and it can move nothing else — runtime state, the audit log, tasks, assets, the
credential store and the vault stay wherever `storage:` and `credentials:` put them. Tasks could
reasonably follow later; assets raises a different question, since binaries in a git repository is
not the trade Markdown is ([ADR-041](adr/041-memory-and-skills-in-a-repository.md)).

```yaml
targets:
  local:
    knowledge:
      adapter: github
      repo: my-org/my-notes       # owner/name, not a URL
      branch: main                # optional; the repository's default branch otherwise
      path: context               # optional prefix, for a repository holding other things
      token_ref: knowledge/token  # a reference, never the token
```

The repository then holds two directories — `memory/<connection>/<id>.md` and
`skills/<name>/SKILL.md`, under `path` if one is given.

You do not write this by hand:

```console
$ lanes link knowledge use github --repo my-org/my-notes --migrate
$ lanes link knowledge show
$ lanes link knowledge use local --migrate     # the same thing backwards
```

That command asks for the token, refuses a repository the token cannot write, **refuses a public
one** unless `--allow-public` says otherwise, moves what is already stored in a single commit,
reads it back before deleting anything, and writes the block into every target the profile
declares. Each target reads the token from its own credential store, so a second one needs
`lanes link secrets push --from local --to cloud`.

The token is its own credential and deliberately not the one `lanes link connect github` holds:
that one needs Contents **read**, this one needs Contents **write**, and revoking either should
not affect the other.

**What it costs**, in one place, because none of it is a fault:

| | |
|---|---|
| Offline | Nothing works. There is no local cache, because a second copy can disagree with the repository. |
| `memory.search` | Reads every entry by design. The first search after a change fetches what changed; after that they come from a cache keyed by content sha. |
| Rate limit | GitHub's 5,000/hour becomes one of this endpoint's own failure modes. The branch is polled conditionally and a `304` costs no quota, so an idle endpoint costs nothing. |
| History | Every write is a commit. That is the feature, and it means deleting an entry does not remove it from the history. |
| `profile remove` | Does not touch the repository. It plans against the target's declared storage, so memory and skills survive removing the profile — the plan says so before you confirm. |

[ADR-041](adr/041-memory-and-skills-in-a-repository.md) has the reasoning, including why this is
the API rather than a clone.

## Environment variables

| | |
|---|---|
| `LANES_LINK_HOME` | Workspace root. Otherwise the nearest ancestor holding `lanes-link.yaml`, else `~/.lanes-link`. |
| `LANES_LINK_PROFILE` | **No longer read** (ADR-037). Pass `--profile`. Named in the refusal when it is set, so a shell configured for the old behaviour says so. |
| `LANES_LINK_TARGET` | **No longer read** by the CLI (ADR-037). Pass `--target`. Still how the container entrypoint selects its adapter set — a deployed revision has no argv. |
| `LANES_LINK_HOST` / `PORT` | Bind address and port in a container. |
| `LANES_LINK_CREDENTIAL_KEY` | base64 32-byte key for the encrypted credential store. |
| `LANES_LINK_VAULT_KEY` | base64 32-byte key for the vault. **A different key, deliberately** — one master secret reused across purposes turns any single compromise into a total one. |
| `LANES_LINK_TOKEN` | Convention only: where `lanes link mcp add codex` tells the harness to read the bearer token from. |
| `LANES_LINK_APP_SCHEME` | Which Lanes build `lanes link desktop` opens. `lanes` by default; `lanes-dev` and `lanes-stage` reach a local debug or Stage build, which register their own URL schemes. |

The two encryption keys are never interchangeable and never shared. `docs/detailed/security.md` explains why
credentials and vault items are different kinds of secret.

## Reconcile

On boot: upsert declared entities; mark undeclared connections **disabled rather than deleted**,
preserving audit history; mark a connection whose credential is missing `unauthorized` **without
blocking startup** — one half-configured account must not stop the profile from serving; report drift
in both directions.

`lanes link plan` prints exactly what reconcile would change, without mutating anything. It exists because
reconcile disables undeclared connections, and that should never be a surprise.
