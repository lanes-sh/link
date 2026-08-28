# Deploying to Cloud Run

The deployed target runs the same code as the local one. A target names an adapter set, and that is
the only thing that changes: the encrypted credential file becomes Secret Manager and the local
directory becomes a bucket. Everything above them — connections, providers, policy, limits — is
declared once and applies to both.

```console
$ lanes link start --profile personal --target cloud   # local:    a directory, an encrypted file
$ lanes link deploy --profile personal --target cloud  # deployed: one bucket, Secret Manager, Cloud Run
```

**Two standing dependencies, and that is the whole list.** No database: state is one object per
key and the audit log is one object per event, both in the same bucket as memory, tasks, assets,
skills, attachments, and the config itself (ADR-020, ADR-021, ADR-023).

If you find yourself needing an application-layer change to make the second one work, that is a bug
in the adapter boundary rather than a step in this guide.

---

## What you need

- A Google Cloud billing account.
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), authenticated:
  `gcloud auth login && gcloud auth application-default login`.

That is the list, and note what is *not* on it: a project. There is no second vendor to sign up
with, no database to provision, and no key pair to mint in a console — the `gcs` adapter
authenticates as the service account the deploy creates, so the bucket needs no credential of its
own.

**The project, its billing link, the APIs, the Artifact Registry repository, the bucket, the runtime
service account and its IAM bindings are all created by `lanes link deploy` on its first run.** Every
one of them follows from what the target declares or from one answer at a prompt, so transcribing
them into a console was work with no decision in it. `--dry-run` prints the whole sequence before any
of it runs.

A project of its own is the default because it is the cleanest boundary available: this one holds
the bucket, the credential store with your live refresh tokens, and nothing else. Deploying into a
project you already use for other things works — type its name at the prompt — but it means a
`secretAccessor` binding in a project whose other workloads you now have to think about.

## The config

One file, two targets. Nothing below `targets:` is target-specific.

**You do not write this.** `lanes link deploy` asks for the handful of things it
cannot derive — project, billing account, region, service name, bucket, and who may reach it —
and writes the whole block, proposing a default for every one. It is shown here because it is
worth being able to read, and because you may want to edit it later; it is not a transcription
exercise. Every adapter below has exactly one workable answer on Cloud Run, and one of the wrong
ones (`storage: filesystem`) *appears* to work.

```yaml
contract: 2

instance:
  profile: personal
  port: 7337

auth:
  mode: bearer
  token_ref: profile/token
  # How a *remote* client — a Claude or ChatGPT connector, including on a phone
  # — gets a token. Omit it entirely and the bearer token is the only way in,
  # which is all a local registration ever needs. See "Who can reach it" below.
  authorization:
    mode: self

connections:
  - id: main
    provider: gmail
    account: you@example.com

policy:
  allow: [gmail.*]
```

## The deploy loop

```console
$ lanes link deploy --profile personal --target cloud                        # everything, from nothing
$ lanes link connect gmail --profile personal --target cloud  # a browser consent per account
$ lanes link outputs --profile personal --target cloud        # the URL an agent needs
```

`connect` publishes the config to the bucket the revision reads and asks the revision to re-read
it, so it takes effect without a second deploy. Deploy again when the *code* changes.

### More than one deployment

`cloud` is a target name rather than a keyword. A second deployment is named on the deploy that
creates it, and everything downstream takes the same flag:

```console
$ lanes link deploy --profile personal --target staging       # surveys, writes targets.staging, rolls a revision
$ lanes link target list --profile personal                   # what this profile declares, and which is in play
$ lanes link secrets push --profile personal --from cloud --to staging
$ lanes link outputs --profile personal --target staging
```

The revision carries its own name — the rollout sets `LANES_LINK_TARGET=<target>` on the service, so
a `staging` container opens `staging`'s adapters. Give each its own project and bucket unless you
intend them to share a credential store; the survey proposes fresh names, so pressing return through
it is the safe answer.

**`deploy` always names its `--target`** (ADR-037). It used to infer one — the target declaring a
`deploy` block, inventing `cloud` when there were none — and that inference was a defence against
`instance.default_target`, which is `local` and by definition not deployed. With the fallback gone
the defence has nothing to defend against, and what was left was three behaviours from one command
line on the command that creates cloud resources and rolls a public URL.

**What it does not name is a profile.** A deploy sends every profile declaring the target, in one
revision, because that is the set the endpoint will open (ADR-009, ADR-041). `--profile` narrows it.
A first deploy is the exception: a target nothing declares yet has no set to derive, so name the
profile it belongs to.

`deploy` is the only command that may name a target which does not exist yet, since creating it is
what a first deploy is for — that is also why it does not read `LANES_LINK_TARGET`, where a typo
would be surveyed and rolled out rather than refused.

`lanes link deploy` runs `check`, asks for anything the config does not say yet and writes the
answers into your profile, creates the project-level resources on a first run, gets the credential
store to a state a revision can boot from, uploads the workspace, builds the image through Cloud
Build, rolls a revision, and prints the URL. It is a wrapper, not a deployment engine: there is no
state file, no lease, no drift reconciliation, and no rollback manifest, because Cloud Run revisions
already are the rollback.

**The order of those matters and used to be wrong.** Provisioning ran after the credential check
and the workspace upload, which is fine on every deploy after the first and impossible on the first:
the credential check asked Secret Manager for a token in a project where that API was not enabled
yet, and the upload wrote into a bucket that did not exist. Both failed several steps before the
step that would have created what they wanted.

**`connect` comes second, not first.** It authorises against a real account and writes into the
target's credential store — which on a first run does not exist until `deploy` has enabled Secret
Manager and created the bucket. The second `deploy` is not a formality either: a revision decides
which connections are usable during its boot reconcile, so one that came up before an account was
authorised goes on refusing it until a new revision replaces it. `deploy` prints both the exact
`connect` commands and this reminder when it finishes.

`lanes link deploy --dry-run` prints every `gcloud` invocation without running any of them, and reads
and writes no credential. Use it the first time, and any time you want to run a step yourself.

### What it asks

**Every run, not just the first.** With no `cloud` target at all it asks for the whole thing —
project, billing account, region, service name, bucket, who may reach it, and whether a remote
client has to — and writes `targets.<target>`, plus `auth.authorization` when the last answer is
yes. With a target already declared it asks only about the deployment: project, region, service,
access.

Every prompt defaults to what the config already says, so **pressing return through the survey
changes nothing and re-generates nothing** — by the second run the random project and bucket names
are stored values, not fresh draws. What it buys is that the four settings deciding where a revision
lands are in front of you each time rather than in a file you have to remember to open, and changing
one costs a line instead of an edit.

The adapters are not re-asked once declared. The bucket holds the config, the state and the log, so
renaming it does not move a deployment, it abandons one — a deliberate edit rather than a prompt to
press return through.

`--access` overrides for a single run without writing anything.

Slow lookups say so. Reading your `gcloud` configuration and checking whether a project exists both
shell out and can take seconds, and a prompt that is *about* to appear looks exactly like one
waiting for input — press return into that silence and the terminal buffers the keystroke for the
question you never saw. Each of those waits now prints what it is doing and takes the line back.

**A run with nobody at the keyboard skips the survey** and uses what the config holds, so a scripted
deploy needs no flag. `--non-interactive` says the same thing explicitly, for a terminal attached to
a job nobody is watching; it assumes the "create these now?" confirm too. Neither can rescue a target
whose answers are missing — that still refuses, at the prompt it could not ask.

**The names it proposes.** A project id and a bucket name are both unique across every Google Cloud
customer, so five random letters are drawn once and both take the same name —
`lanes-link-<random>`. One string, two namespaces, and finding either from the other needs nothing
written down. They are written into your profile, so the second deploy reads them back; a fresh
suffix per run would name a fresh empty project beside the one holding everything.

The service name carries the profile instead: `lanes-link-<profile>-mcp`. That is the name that has
to differ when one project serves two profiles, and the one you read in the Cloud Run console
months later.

The default project used to be whatever `gcloud config` was pointed at — a value that is always
set, rarely the right one, and wrong in the expensive direction: accepting it puts a credential
store holding live refresh tokens into whichever project you last worked on.

**The billing account** is asked only when the project does not exist yet, since that is the only
time it changes anything, and it is refused rather than defaulted when the login has no open
account — a project without billing enables no API, and every step after it then fails describing
the API rather than the billing.

### Getting the credentials in

A deployed instance never mints its own token, and writes exactly one thing: the vault document,
if you use the vault. Everything else flows one way, from your CLI. `deploy` mints the endpoint
bearer token into the target's store if there is none, and asks for nothing else — a value already
in the store is left alone.

If you would rather do it up front, or copy a setup you already built locally:

```console
$ lanes link token rotate --profile personal --target cloud            # mints the profile bearer token
$ lanes link secrets push --profile personal --from local --to cloud   # or copy a setup you built locally
```

`secrets push` copies; it never deletes from the source, and it skips a reference the destination
already holds unless you pass `--overwrite`. That default matters: a token rotated against the cloud
target is newer than your local copy, and overwriting it silently would break the deployed instance
with no error anywhere.

`lanes link secrets set` reads the value from **stdin**, not from an argument — an argument is in your shell
history, in `ps` output while the command runs, and in any transcript of the session.

### What the service account needs

Four bindings, each narrower than it looks:

| Grant | Scope | Why not wider |
|---|---|---|
| `roles/secretmanager.secretAccessor` | **one binding per secret it reads** | Read at boot and while serving: OAuth refresh tokens, the endpoint's own bearer token, the vault key. |
| `roles/secretmanager.secretVersionAdder` | **one binding per secret it rotates** | The vault document, and each connection's OAuth token. Add a version, never create — see below. |
| `roles/storage.objectAdmin` | **conditioned** on `data/`, less each profile's `providers.d/` | What the endpoint owns and writes: state, the log, attachments, memory, and skills (writable under policy, ADR-014). Manifests are carved back out — they are config, and ADR-007 says a revision never rewrites its own. |
| `roles/storage.objectViewer` | `profiles/`, `lanes-link.yaml`, and each `providers.d/` | Reading its own config. Deliberately *not* admin — see below. |

`deploy` creates the account and all of them on a first run; `--dry-run` shows them, and
`--service-account` names a different one.

**And it takes away the ones it replaced.** `gcloud ... add-iam-policy-binding` *adds*: a binding is
keyed on role, member and condition together, so changing a condition's expression writes a second
binding beside the first, and IAM evaluates the set as a permissive union — the widest expression
wins. Three deploys in a row narrowed `reads-its-config` while the revision went on holding
`objectViewer` on every object in the bucket, under a title claiming the opposite, because the two
attempts before them had been refused by CEL and every step here tolerates failure.

So each deploy reads the policy it is about to change and removes what it superseded: a binding
under one of these condition titles whose expression is no longer the one being applied, an
unconditioned binding on a role that is only ever granted conditionally, and the project-wide
`secretAccessor` that per-secret reads replaced. Additions run first and removals after, always —
the two are one edit to a live policy, and the other order opens a window in which the revision
currently serving holds no grant at all.

Nothing is recorded between deploys to make that work. There is no state file, no lease and no drift
reconciliation ([`init.md`](init.md) rules all three out, and a record would only ever agree with
itself); the policy is read, because IAM is the thing that actually decides. A policy that cannot be
read — no `gcloud`, a bucket that does not exist yet, a login without the permission — plans no
removals at all rather than guessing.

**Why the write grant is conditioned.** ADR-007 says a deployed instance never mutates its own
configuration. That used to be enforced by the config being baked into a read-only image, which
stopped being true when the workspace moved into the bucket (ADR-023). The condition is where that
guarantee went: the revision may write what it owns and may only read what declares what it is. A
blanket `objectAdmin` would silently undo it, which is why `driver.test.ts` asserts the shape.

**Why the Secret Manager write grant is per secret.** The line is not read versus write — the
revision plainly writes — it is *rotating what exists* versus *bringing something into existence*.
Two things it does are writes:

- **Refreshing an OAuth token.** Access tokens last about an hour and the refreshed one is persisted,
  so an ordinary "check my mail" rewrites `gmail/<connection>` a few times a day. This is not a
  background job you can grant separately; it happens inside the request.
- **`vault put`**, which is a write an agent may legitimately make under policy (ADR-022).

So `deploy` binds `roles/secretmanager.secretVersionAdder` on each of those secrets by name, and
creates each container itself so the revision never needs `secretmanager.secrets.create` — a
project-level permission that would let it mint credential references of its own, and destroy
versions. A binding on one secret is already scoped to it, so none of these needs a condition to be
narrow. See ADR-026.

The list is scoped exactly as the upload is: a deploy naming no `--profile` sends every profile up,
so it binds every profile's connections. A connection authorised *after* a deploy has no binding —
and no config in the bucket either, so the revision cannot reach it at all until the
`lanes link deploy` that `connect` already tells you to run.

### Credential references become secret ids

Secret Manager ids allow `[A-Za-z0-9_-]`, and a credential reference contains `/`. The adapter
encodes the separator as `__`, so `gmail/main` is stored as `gmail__main` and `vault/document` as
`vault__document`. That encoding lives entirely inside the adapter — every command still speaks
in references — but it is what you will see in the console, and it is why a reference whose own
segments contain `__` is refused rather than silently sharing a secret with another one.

Secrets in the project that do not decode to a valid reference are ignored, so sharing a project with
other workloads is fine.

---

## Storage is not optional up here

`adapter: filesystem` on Cloud Run **appears to work**. Every write succeeds, every read within the
life of an instance succeeds, and the bytes are gone when the instance recycles — which it does on
idle, on deploy, and whenever the platform feels like it. Nothing errors, because from the
container's point of view nothing is wrong.

That was worth stating when the bucket held only memory and skills. It is worth more now: the
bucket also holds the config the endpoint reads, its connection state, its audit log, every task,
and every file kept as an asset. A deployment on the filesystem adapter is one that forgets what it
did — and for assets that is the only copy, since the point of keeping one is that the endpoint can
reach it from anywhere.

That mix is also why the deploy creates the bucket with **Autoclass**, terminal class `ARCHIVE`. The
same bucket holds the config read on every boot and an attachment nobody opens twice, so no single
storage class is right for it and a lifecycle rule would be a guess written by hand. Autoclass moves
each object on its own access pattern — untouched for thirty days it cools to Nearline, and it keeps
sinking to Archive from there — and inside such a bucket there are no retrieval fees and no
early-deletion fees, so a read pulls the object back to Standard at no charge. That is what makes
the colder floor safe rather than a bet on never needing the file again. Objects under 128 KiB never
leave Standard at all, so the config, the state and the log rows are untouched by this; the saving
is on assets and attachments.

It applies to a bucket the deploy creates. A bucket from an earlier deploy is left exactly as it is
— the create step finds it present and moves on — so turning Autoclass on for an existing one is a
change you make yourself, in the console or with `gcloud storage buckets update`.

### The vault key, which the deploy now mints

The vault document is sealed before it reaches Secret Manager, under `LANES_LINK_VAULT_KEY` — a
different key from `LANES_LINK_CREDENTIAL_KEY`, deliberately, because one master secret reused
across purposes turns any single compromise into a total one.

`lanes link deploy` mints it, the same way and for the same reason it mints the endpoint token: it
is a random string the process generates correctly and nobody can usefully choose. It is stored at
the reference `vault/key` in the target's own credential store — the secret `vault__key` — and
mounted on the revision as `--set-secrets LANES_LINK_VAULT_KEY=vault__key:latest`, so the value
never appears in argv, in a revision's description, or in anything `describe` returns.

This used to be three manual commands, and their only failure mode was forgetting them: the
revision booted healthy and every `vault.*` call failed at the first read.

Beside the document rather than somewhere else, which reads wrong and is not — ADR-022 put the
ciphertext in Secret Manager *because* the key already came from there. What separates them is that
the key is mounted as an environment variable and the document is not, so an attacker holding the
document alone holds ciphertext.

It is never regenerated. A second key does not fail loudly; it decrypts nothing, and what it cannot
open is every password the owner put there.

`lanes link vault key generate` still exists, for a local run or a key you would rather carry
yourself.

## Cold starts

With minimum instances at zero, the first agent call after an idle period pays for:

1. **Container start** — pulling and starting the image, then Bun booting. Bun runs TypeScript
   directly, so there is no bundle to load, and the image is small.
2. **Config read** — a couple of object reads from the bucket. There is no database to connect to
   and no schema to migrate, so this step is two HTTPS requests rather than a TLS handshake plus a
   lock.
3. **Reconcile** — one plan per profile against the config just read.

Expect a few seconds. An agent call that normally takes a second takes several after idle, once, and
then not again until the instance is reaped.

Your options are exactly two, and both are legitimate:

- **Accept it.** For a personal gateway this is the right default. `--min-instances=0` costs nothing
  while idle.
- **Set `--min-instances=1`.** The first call is fast every time, and you pay for an always-warm
  instance.

```console
$ gcloud run services update lanes-link-personal-mcp \
    --min-instances=1 --region europe-west1 --project my-project
```

Leave CPU allocation at "CPU only during requests". The server is stateless and does no background
work between requests, so allocating CPU always would pay for idle time and buy nothing.

---

## Who can reach it, and what scaling changes

There are two doors, and they are not alternatives — they are layers, and only the inner one can
admit an agent.

**The platform door** is `deploy.access`. `iam` deploys with `--no-allow-unauthenticated`, so Cloud
Run checks the caller before the request ever reaches this code. What it checks is a *Google-signed
identity token* for this service, held by a principal with `roles/run.invoker`. No agent harness can
mint one — not Claude, not ChatGPT, not a `claude mcp add` registration — so `iam` is the right
choice for a service reached by other cloud workloads and the wrong one for a service reached by an
MCP client, which will see nothing but 403s.

**The application door** is `src/auth`, which does not know or care which target it is running on.
It accepts two kinds of credential:

- The **profile bearer token**, resolved from the credential store — the same mechanism as locally.
  This is what `claude mcp add --header` and every local registration carry.
- A token obtained through **`auth.authorization`**, for a remote client that has nowhere to paste a
  fixed string.

`access: iam` is the default, because a target that says nothing about who may reach it should get
the closed answer. A target you intend to reach from an agent declares `access: public`.
`--access iam|public` overrides the declared value for one run; `--iam` is still accepted and means
`--access iam`.

There is no way to serve without authentication. `--no-auth` existed, printed that it had disabled
authentication, and did not — the flag reached a bind-address guard and never reached an
authenticator, so every request was still refused. It has been removed rather than repaired: the
loopback endpoint it would have opened has no Origin check standing behind it, so any page the
owner visited could have read their accounts.

`/health` answers `{"status": "ok"}` without a token, so the platform's probe and `deploy` can wait
on it. It names the profiles it serves only to a caller holding one — that list is an inventory of
what this instance holds, and a deployed URL is readable by anyone.

### Connecting a phone

`mode: self` means this endpoint issues the tokens, and there is nothing to set up: no OAuth client,
no console, no redirect URI. Deploy, then add a custom connector by URL in Claude or ChatGPT. The
client registers itself, a browser opens on this endpoint's approval page, and you paste the
endpoint token once — the string `lanes link outputs --show --target cloud` prints. That is the
whole flow, and it works the same on a laptop and on a phone.

Name the target. Credentials are per-target, and a bare `lanes link outputs --show` resolves to
`instance.default_target` — `local` on a scaffolded profile, whose token this endpoint has never
seen and will refuse. Worse, when that store is empty the command mints a fresh local token rather
than reporting that it has none, so what you paste looks like an answer and fails as a wrong
password. The approval page prints the target it is actually running as, so the command it shows
you is the one to run.

What makes it work is a handshake worth knowing about when it does not: `/mcp` answers `401` with a
`WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource`, which names this
origin as the authorization server, whose own document lives at
`/.well-known/oauth-authorization-server`. All three are readable without a token, deliberately —
they are how a client learns it needs one. If a connector reports the server as unreachable, curl
those three in order; the first one that does not answer is the problem.

```console
$ curl -i -X POST https://…run.app/mcp | head -3          # 401, with resource_metadata
$ curl -s https://…run.app/.well-known/oauth-protected-resource | jq
$ curl -s https://…run.app/.well-known/oauth-authorization-server | jq
```

### Calling it from a browser

Nothing to configure. A deployment answers a cross-origin request from any page, because there is
nothing for an allowlist to defend: the endpoint is already reachable by anyone, the credential is an
`Authorization` header a page must already hold rather than a cookie a browser attaches on its own,
and `Access-Control-Allow-Credentials` is never sent.

To narrow it anyway — an enterprise deployment might — name the origins:

```yaml
auth:
  mode: bearer
  token_ref: profile/token
  allowed_origins:
    - https://app.example
```

An origin exactly: scheme, host, and port, with no trailing slash and no path. A browser sends
`Origin: https://app.example`, and a configured `https://app.example/` compares unequal and would
refuse the origin you believed you had allowed — so the config refuses it up front rather than at
request time. The discovery documents are never narrowed by this; a client that cannot read them
cannot find out that it needs a token.

Two things it does not do. It grants no capability: what a caller may do once it holds a credential is
decided by `policy`, per call, exactly as for every other client. And it does nothing at all for
`lanes link start` — a loopback endpoint refuses every cross-origin request and must keep doing so,
because a page you happen to be visiting can otherwise reach `127.0.0.1`, including the consent form
that asks you for your token. The field is read and discarded there. See
[ADR-039](adr/039-cross-origin-access-is-a-deployment-only-grant.md).

### Using an identity provider you already run

`mode: oidc` points the same handshake at somebody else's authorization server and reduces this
endpoint to verifying what comes back — against the audience, the expiry, and an allowlist of
subjects.

```yaml
auth:
  authorization:
    mode: oidc
    issuer: https://accounts.google.com
    client_id_ref: oidc/client_id
    # Only when the issuer publishes no `introspection_endpoint` of its own.
    introspection_endpoint: https://oauth2.googleapis.com/tokeninfo
    allowed_subjects: [you@example.com]
```

The cost is setup, and it is worth being clear about before you choose it. The issuer needs an OAuth
client registered for this endpoint, with `https://claude.ai/api/mcp/auth_callback` among its
redirect URIs, and the client id stored at `client_id_ref`. Google in particular supports neither
dynamic client registration nor client-ID metadata documents, so its client id and secret have to be
pasted into the connector's advanced settings by hand — and ChatGPT, which needs dynamic
registration, likely cannot use that combination at all. `mode: self` is the default for exactly
these reasons. See [ADR-018](adr/018-the-gate-is-in-the-application.md).

The `allowed_subjects` list is not optional and may not be empty. An issuer will vouch for every
account it has; which of them is *you* is not something it knows.

**Rate limits are per instance.** `limits.requests_per_minute` is enforced by an in-memory counter, so
a service running N instances enforces N times the configured limit in aggregate. A shared counter
store would be needed for a global limit, and that is not in scope. If the limit matters to you as a
ceiling rather than as a guard against a runaway agent, cap `--max-instances` accordingly.

---

## The image

`src/deployments/gcp/Dockerfile`, built from the repository root through
`src/deployments/gcp/cloudbuild.yaml`. Two things about it are worth knowing.

**The config is not in it.** The image carries no `lanes-link.yaml` and no `profiles/`; `deploy`
uploads them to the bucket and passes `LANES_LINK_HOME=gs://<bucket>` at rollout, so one image
serves any workspace (ADR-023). It used to be baked in, and the image being read-only was what
enforced "a deployed instance never mutates its own configuration" — that guarantee now lives in
the conditioned `objectAdmin` binding, which is why the condition is worth keeping narrow.

What that costs is rollback. A revision no longer fully describes what it serves, so rolling back
to an earlier revision does not roll back a config change made since; the bucket holds one current
copy. The upload is an allowlist — `lanes-link.yaml`, `profiles/<profile>.yaml`, and the two
authored directories inside the profile, `data/<profile>/skills.d/` and
`data/<profile>/providers.d/` — so the rest of `data/` cannot travel by accident, for the same
reason `.dockerignore` excludes it.

**Everything else under `data/` is excluded, and that exclusion is load bearing.** The local
encrypted credential store and its key live there. The root `.dockerignore` keeps them out of the build context; a credential baked
into an image is pushed to a registry, cached on every builder that touched it, and readable by anyone
who can pull the tag. The deployed target reads credentials from Secret Manager and wants nothing from
that directory.

The entrypoint is `src/server/container.ts`, not `lanes link start`. It logs plain lines to stdout for
Cloud Logging, handles SIGTERM, listens on `$PORT`, and — importantly — **refuses to start when the
profile token is missing** rather than minting one. A token invented inside a container that scales to
zero is a token nobody can read back, and the endpoint would come up healthy while rejecting every
agent.

To run the image locally against the cloud target's adapters:

```console
$ docker build -f src/deployments/gcp/Dockerfile -t lanes-link .
$ docker run --rm -p 8080:8080 \
    -e LANES_LINK_TARGET=cloud \
    -e GOOGLE_APPLICATION_CREDENTIALS=/adc.json \
    -v ~/.config/gcloud/application_default_credentials.json:/adc.json:ro \
    lanes-link
```

---

## Troubleshooting

**`No profile token at "profile/token"`** — the container refuses to invent one. Run
`lanes link token rotate --target cloud`. A running revision re-reads within five seconds, so
neither a redeploy nor a fresh instance is needed; it used to be, because the value was cached for
the life of the process.

**`PERMISSION_DENIED: Permission "secretmanager.versions.access" denied`** — the revision's service
account is missing `roles/secretmanager.secretAccessor`. The adapter passes Google's message through
verbatim, and it names the permission.

**`PERMISSION_DENIED: Permission "secretmanager.versions.add" denied`, on a read** — reading mail
refreshes an OAuth token and persists it, so the credential's secret needs a
`secretVersionAdder` binding and this one has none. Almost always a connection authorised since the
last deploy. `lanes link deploy` binds it; the message says so and names the ref.

**`PERMISSION_DENIED: Permission "secretmanager.secrets.create" denied`** — do **not** reach for
`roles/secretmanager.admin` here. It reads as "the secret does not exist yet" and usually does not
mean that: Google checks IAM before existence, so this is also what a create against a secret that
is right there answers. Nothing in a running revision should be creating a secret at all, so a 403
here on the serve path means something asked for a permission it does not need — which was a real
bug, fixed in ADR-026. On the CLI side it means your own account cannot create secrets in that
project.

**`PERMISSION_DENIED: The caller does not have permission` during a step, on a project you own** —
enabling an API returns before the API is usable, and inside that gap Google answers calls to it
with a permission error rather than a "still starting" one. `deploy` enables seven APIs and then
uses all of them, so it is the most likely thing here to land in that window. It now waits: a step
that fails this way is retried with a backoff, against a budget of about two and a half minutes
shared across the whole run, and says so on each retry. If it still fails afterwards the message is
Google's and the problem is real.

**`GCS refused to write "…" (403)`** — the revision's service account is not granted
`roles/storage.objectAdmin` on the bucket, or the deploy's IAM step was skipped. The message names
the role. Note the grant is conditioned: the revision may write under `data/` and may only *read*
the config paths, so a 403 on `profiles/…` — or on a `providers.d/…` key, which sits inside `data/`
and is excluded from the write grant by name — is the guarantee working rather than a
misconfiguration.

**The endpoint answers 401 for a token you just printed** — `claude mcp add` stores the substituted
value, not the command, so a rotated token needs re-registration. `lanes link outputs` prints the command.

**`lanes link outputs` shows a local URL for a cloud target** — it asks Cloud Run for the service URL and
falls back to the configured host and port when `gcloud` is absent or the service is not deployed yet.

## A brokered Google connection on Cloud Run

Nothing extra to bind. A connection authorised against the OAuth client Lanes operates rewrites
exactly one secret while serving — its own token blob — which is already in the rotation grant, and
it needs no client id or secret anywhere in the target's store.

The one requirement is **outbound HTTPS to the broker host**, which Cloud Run has by default. It
only becomes a question if you have set VPC egress to route all traffic: the revision refreshes
through `api.lanes.sh`, so that host has to be reachable or every Google call fails an hour after
the revision reports healthy.

A profile that registered its own client is the other way round: its `oauth_apps` refs are bound
**readable** by `deploy` so the refresh path can sign with them, and never writable —
[ADR-026](adr/026-a-revision-rotates-its-own-credentials.md)'s line is that a revision rotates what
is its own and never rewrites the operator's client.
