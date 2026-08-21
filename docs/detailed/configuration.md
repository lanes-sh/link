# Configuration

One profile = one config file = one blob store = one credential store. One endpoint serves them all.

```
lanes-link.yaml          workspace settings: contract, default_profile
profiles/
  personal.yaml
  work.yaml
data/                   local state per profile, gitignored
```

A real config is gitignored; only `*.example.yaml` is committed.

## A complete profile

```yaml
contract: 1

instance:
  profile: personal
  default_target: local
  port: 7337
  host: 127.0.0.1

# Adapter selection is per target. Everything below "targets" is
# target-independent and declared exactly once.
targets:
  local:
    credentials: { adapter: file,       path: ./data/personal.credentials.enc }
    storage:     { adapter: filesystem, path: ./data/personal/files }

# The bearer token for the endpoint this profile serves. One "lanes link start"
# serves every profile in the workspace from one URL, and this token opens it —
# so it admits all of them, not only this profile.
auth:
  mode: bearer
  token_ref: profile/token

limits:
  requests_per_minute: 120        # per profile
  upstream_calls_per_minute: 60   # per connection, protects vendor quota

# App registrations, shared by every connection of that vendor.
#
# Also the switch. A provider whose manifest names a broker — every Google REST
# provider does — authorises against the client that broker operates when there
# is no entry here, and against yours when there is. Written for you by
# "lanes link connect <provider> --own-client"; delete it to go back.
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
connections:
  - id: ada_lovelace
    provider: gmail
    account: ada.lovelace@example.com
  - id: rin_shaw
    provider: gmail
    account: rin.shaw@example.com

# Only what is listed here is reachable, and an empty policy grants nothing.
policy:
  allow: ['*']
  deny:  [gmail.users.drafts.send]
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

## A profile that uses the hosted OAuth client

The default, and the shorter file: there is no `oauth_apps` block at all, because there is no client
to point at. The Google connections below authorise against the client Lanes operates, and its
secret is never on this machine.

```yaml
contract: 1

instance:
  profile: personal
  default_target: local

targets:
  local:
    credentials: { adapter: file }
    storage: { adapter: filesystem, path: ./data }

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
7. **`default_target` and any `--target` must name a declared target.**
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

One config can run in more than one place. A target names an adapter set; connections, providers,
policy, and limits are declared once and apply to every target.

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

`local` and `cloud` are conventions, not keywords — nothing reserves either name, and a profile may
declare as many targets as it has places to run. A second deployment is named on the deploy that
creates it (`lanes link deploy --target staging`), which surveys for what it does not know and
writes the block below.

```yaml
contract: 1

instance:
  profile: personal
  default_target: local

targets:
  local:
    credentials: { adapter: file }
    storage: { adapter: filesystem }

  cloud:
    credentials: { adapter: gcp-secret-manager, project: my-project }
    storage: { adapter: gcs, bucket: your-bucket }
    vault: { adapter: secret }
    deploy:
      platform: cloudrun
      project: my-project
      region: europe-west1
      service: my-service
      access: public

  staging:
    credentials: { adapter: gcp-secret-manager, project: my-other-project }
    storage: { adapter: gcs, bucket: your-other-bucket }
    vault: { adapter: secret }
    deploy:
      platform: cloudrun
      project: my-other-project
      region: europe-west1
      service: my-other-service
      access: public
```

`lanes link target list` prints what a profile declares and which target is in play;
`lanes link target use <name>` rewrites `instance.default_target`. Once two targets declare a
`deploy` block, a bare `lanes link deploy` asks which you meant rather than picking.

Each target's credential store is its own, so a connection authorised against `cloud` is absent from
`staging` — `lanes link secrets push --from cloud --to staging` copies them across instead of
re-running every consent.

Two cloud blob adapters, and the difference is setup rather than capability. `gcs` authenticates
as the identity already present — the service account `lanes link deploy` grants `objectAdmin`, or
your own gcloud credentials locally — so the bucket needs **no credential of its own**. `s3` needs
an endpoint and an HMAC key pair, which on GCS means a console visit to mint one; it is the answer
for R2, MinIO, Supabase Storage, and AWS.
**`BlobStore` is not optional in the cloud** — state, the log, memory, and skills all live in it,
and a container filesystem loses every one of them on an instance recycle without reporting
anything.

### The vault block

Optional, and defaulting to `file`, so a profile that predates it keeps working and a local run needs
no vault configuration at all:

```yaml
targets:
  cloud:
    vault: { adapter: blob }      # the target's own storage; key defaults to vault.enc
```

The `blob` adapter **requires `LANES_LINK_VAULT_KEY`** and will not mint a key. The file adapter may,
because it writes one to a sibling `<path>.key` at mode 0600 that outlives the process; a deployment
has no equivalent, and a key generated per revision would make every stored item permanently
unreadable while appearing to work. Mint one with `lanes link vault key generate`.

## Environment variables

| | |
|---|---|
| `LANES_LINK_HOME` | Workspace root. Otherwise the nearest ancestor holding `lanes-link.yaml`, else `~/.lanes-link`. |
| `LANES_LINK_PROFILE` | Profile, below `--profile` and above the workspace default. |
| `LANES_LINK_TARGET` | Target, below `--target` and above `instance.default_target`. Not read by `deploy`. Also how the container entrypoint selects its adapter set. |
| `LANES_LINK_HOST` / `PORT` | Bind address and port in a container. |
| `LANES_LINK_CREDENTIAL_KEY` | base64 32-byte key for the encrypted credential store. |
| `LANES_LINK_VAULT_KEY` | base64 32-byte key for the vault. **A different key, deliberately** — one master secret reused across purposes turns any single compromise into a total one. |
| `LANES_LINK_TOKEN` | Convention only: where `lanes link mcp add codex` tells the harness to read the bearer token from. |

The two encryption keys are never interchangeable and never shared. `docs/detailed/security.md` explains why
credentials and vault items are different kinds of secret.

## Reconcile

On boot: upsert declared entities; mark undeclared connections **disabled rather than deleted**,
preserving audit history; mark a connection whose credential is missing `unauthorized` **without
blocking startup** — one half-configured account must not stop the profile from serving; report drift
in both directions.

`lanes link plan` prints exactly what reconcile would change, without mutating anything. It exists because
reconcile disables undeclared connections, and that should never be a surprise.
