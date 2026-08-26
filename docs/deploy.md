# Deploy to your own cloud

Deploy when you want to reach your endpoint from something that is not your laptop — claude.ai,
ChatGPT, or a phone.

The same code and the same config run in both places. A target names a set of storage adapters, and
that is the only difference: locally a directory and an encrypted file, deployed one bucket and
Secret Manager. Connections, providers, permissions, and limits are declared once and apply to both.

## What you need

- A Google Cloud billing account.
- The [`gcloud` CLI](https://cloud.google.com/sdk/docs/install), authenticated with
  `gcloud auth login && gcloud auth application-default login`.

That is the list. Note what is not on it: a project. There is no database to provision and no key
pair to mint in a console — the first `deploy` creates the project, links billing, enables the APIs,
mints the service account and the bucket, and builds the image.

## The four commands

```console
$ lanes link deploy --profile personal --target cloud --dry-run              # every gcloud command, none of them run
$ lanes link deploy --profile personal --target cloud                        # creates the project and rolls a revision
$ lanes link connect gmail --profile personal --target cloud  # a browser consent per account
$ lanes link outputs --profile personal --target cloud        # the URL your agent needs
```

`connect` comes *after* the deploy: a credential store that does not exist yet is not somewhere to
write a credential. And `outputs` comes after *both* — register your agent last. A client reads the
tool list when it connects and keeps it, so one registered before the accounts holds a list without
them and has to be removed and re-added (ADR-032). `lanes link tools --target cloud` shows what a
client would be handed.

There is no second deploy. `connect` copies the config to where the running revision reads it and
asks that revision to re-read it, so the account is reachable as soon as the browser consent is
done. Deploying is how new code gets there, and authorising an account changes no code (ADR-029).

`--target cloud` is on every one of them because every command names its target (ADR-037). There is
no default to leave unset and nothing to forget: a command without it refuses rather than acting on
`local` and leaving the deployment without the account.

`cloud` there is a name, not a keyword — it is what the first deploy calls the target it creates.
`lanes link target list` shows what your profile declares and which one commands are using.

Already built a workspace locally? `lanes link secrets push --from local --to cloud` migrates it
instead of the `connect` step. It copies and never deletes, and skips anything the destination
already holds unless you pass `--overwrite`.

## A second one

Name it, and everything downstream takes the same flag:

```console
$ lanes link deploy --profile personal --target staging          # its own project, bucket, and service
$ lanes link connect gmail --profile personal --target staging   # same ordering: accounts before the URL
$ lanes link outputs --profile personal --target staging
```

Every command that acts on one account names its profile and target, and nothing else supplies
them — no environment variable, no key in a file. That is deliberate (ADR-037): a selection you
did not type is one you cannot check. A shell alias is the way to shorten it, and it is yours to
write.

`deploy`, `status` and `sync targets` are the exception, and not because the rule is relaxed for
them: their subject is the endpoint, which serves every profile in the workspace. They name the
target, and `--profile` narrows what they act on rather than selecting it (ADR-043).

## Which profiles it serves

`lanes link deploy --target cloud` sends **every profile that declares `cloud`**, in one revision,
and the endpoint serves all of them under one token. That set is the same one the endpoint will
try to open, which is why it is derived rather than typed.

```console
$ lanes link deploy --target cloud                        # every profile declaring it
$ lanes link deploy --target cloud --profile personal     # only this one
```

A first deploy is different: a target no profile declares yet has no set to derive, so name the
profile it belongs to and `deploy` creates the target in it.

Two things it will not decide for you. **Which profile owns the endpoint's token**, because one
token reaches every profile behind it — you are asked once, and the answer is remembered. And
whether the profiles can **share a credential store** at all: references are flat, so two profiles
in one project both declaring `gmail/main` are declaring the same secret, and `deploy` refuses
rather than letting the second overwrite the first. Give the connections different ids, or use a
second target in its own project.

## If the target goes missing from your profile

The six lines declaring `cloud` in your profile are the only thing in the workspace pointing at
the service, the bucket, and the credential store. Edit that file badly — or let a tool rewrite
it — and every command reports the target as undeclared, while the deployment carries on
answering:

```console
$ lanes link status --target cloud
Profiles
  personal  not declared  —

Endpoint
  No profile declares "cloud".
```

Nothing is lost. The bucket still holds the profile exactly as the last deploy left it, and
`sync targets` merges the two copies back together:

```console
$ lanes link sync targets --target cloud --dry-run   # see what each side is missing
$ lanes link sync targets --target cloud
personal
  ← targets.cloud             missing locally
  ← auth.authorization        missing locally
  ← connections.gmail.work    missing locally
```

It finds the bucket from the target you still declare, then from the `deployments:` index
`deploy` writes into `lanes-link.yaml`, then from `--from gs://<bucket>` if you know it, then
from `--discover`, which asks the platform and is the only one that works from nothing.

It merges in both directions and never overwrites: anything one side is missing is copied to it,
and anything both sides hold differently stops the run and prints the difference. `--prefer local`
or `--prefer remote` decides those. Credentials, state and the audit log are never copied.

## Two answers in the first run decide whether an agent can reach it

`lanes link deploy` asks a short set of questions and writes the config from your answers. Two of
them matter more than the rest:

**Who may reach it.** The default, `iam`, has Cloud Run demand a Google-signed identity token before
the request reaches Lanes Link — no agent can mint one, so an MCP client sees nothing but 403s. If
you intend to reach it from an agent, answer **public**. The endpoint is still gated; the gate is
this application's bearer token rather than the platform's front door.

**Whether you will add it to Claude or ChatGPT.** Answering yes is what lets the endpoint issue its
own tokens. Without it, a remote connector has no way to obtain one. There is nothing to set up for
this — no OAuth client, no console, no redirect URI.

Both are editable afterwards, but a wrong answer here presents as "the server is unreachable" rather
than as a configuration error, so it is worth getting right the first time.

## Then register it

```console
$ lanes link mcp add claude --profile personal --target cloud
```

Each target has its own credential store, so the deployed token is a different string from the local
one. For claude.ai, ChatGPT, or a phone, add a custom connector by URL — see
[Add it to your agent](clients.md#claudeai-chatgpt-and-your-phone).

## Storage is not optional up here

State, the audit log, memory, skills, and your own provider manifests all live in the bucket. A container filesystem loses every
one of them on an instance recycle without reporting anything, so the deploy configures the bucket
for you rather than leaving it to a flag.

---

**Full reference:** [`detailed/deployment-cloudrun.md`](detailed/deployment-cloudrun.md) covers cold
starts, scaling, what the service account is granted and why, the image, using an identity provider
you already run, and troubleshooting.
