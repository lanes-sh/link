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

## The five commands

```console
$ lanes link deploy --dry-run              # every gcloud command, none of them run
$ lanes link deploy                        # creates the project and rolls a revision
$ lanes link connect gmail --target cloud  # a browser consent per account
$ lanes link deploy                        # again, so the revision sees them
$ lanes link outputs --target cloud        # the URL your agent needs
```

`connect` comes *after* the first deploy: a credential store that does not exist yet is not somewhere
to write a credential. The second deploy is what gets a revision to pick up the accounts you just
authorised.

Already built a workspace locally? `lanes link secrets push --from local --to cloud` migrates it
instead of the `connect` step. It copies and never deletes, and skips anything the destination
already holds unless you pass `--overwrite`.

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
$ lanes link mcp add claude --target cloud
```

Each target has its own credential store, so the deployed token is a different string from the local
one. For claude.ai, ChatGPT, or a phone, add a custom connector by URL — see
[Add it to your agent](clients.md#claudeai-chatgpt-and-your-phone).

## Storage is not optional up here

State, the audit log, memory, and skills all live in the bucket. A container filesystem loses every
one of them on an instance recycle without reporting anything, so the deploy configures the bucket
for you rather than leaving it to a flag.

---

**Full reference:** [`detailed/deployment-cloudrun.md`](detailed/deployment-cloudrun.md) covers cold
starts, scaling, what the service account is granted and why, the image, using an identity provider
you already run, and troubleshooting.
