# Lanes Link

[![npm version](https://img.shields.io/npm/v/%40lanes-sh%2Flink?style=flat-square&color=black&label=npm)](https://www.npmjs.com/package/@lanes-sh/link)
[![license Apache-2.0](https://img.shields.io/github/license/lanes-sh/link?style=flat-square&color=black)](LICENSE)
[![ci](https://img.shields.io/github/actions/workflow/status/lanes-sh/link/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/lanes-sh/link/actions/workflows/ci.yml)

**One endpoint you own, holding everything your agents need to know you: connections, memory, tasks, files, contacts, and secrets.**

You own it and you run it. Connect your mail, calendar, files, and notes once, and add the memory,
tasks, and procedures that only you have. Every agent you use — Claude, ChatGPT, and anything else
that speaks MCP — reaches all of it through that one endpoint. Change your AI and you keep your
context, because none of it ever lived in the agent. Open source, self-hostable, no vendor in the
middle of your data.

![Left: every agent wired directly to every account, each line crossing the others. Right: the same three agents reaching one Lanes Link endpoint, which fans out to Gmail, GitHub, Slack, memory, skills, and a task list through an Access Profile named engineering.](docs/images/lanes-link-hero.png)

## Why

- **Connect once, use everywhere.** No per-agent integrations, no re-authorising every new tool.
- **You decide what agents can touch.** Permissions default to deny, and the runtime enforces
  them — it does not ask the model to behave.
- **Work and personal never mix.** Separate profiles, separate credentials, separate stores.
- **Every call is recorded.** An append-only log of what was reached, and what was refused.
- **It is yours to move.** What you store is plain files on your own disk — readable in an editor,
  backed up like anything else, and portable to a private Git repository or to another machine
  whenever you want. There is no export to ask for.

## What people use it for

- **A personal assistant on your phone.** A deployment is a URL, so the claude.ai or ChatGPT app
  reaches your mail, calendar, and files from anywhere — "what's on tomorrow", "reply to Ana's
  thread", "find the invoice from March". This is the case that needs [your own
  cloud](#run-it-anywhere); everything below works on your machine.
- **Inbox triage you sign off on.** An agent searches, reads, labels, and composes — and saves a
  draft for you to send rather than sending it, until you decide otherwise.
- **Coding agents that start from your context.** Claude Code and Codex reach the same Linear
  issues, Notion pages, and notes you do, so a session begins from what you already know instead
  of an empty prompt.
- **One set of notes behind every agent.** What you have Claude Code write down, claude.ai reads
  back later — your accumulated context follows you between tools instead of being trapped in
  whichever one recorded it.
- **A to-do list your agents share.** "Remind me to chase the invoice" lands somewhere with a
  status, so whichever agent you are talking to next knows it is still open — and knows when it
  is done.
- **Your own procedures, followed rather than guessed.** How a standup update reads, where an
  invoice gets filed, who gets cc'd on a contract — written down once, and every agent you use
  follows the same one.

## Quickstart

Needs [Bun](https://bun.com) 1.3.11+, and a Lanes sign-in.

```console
$ bun install -g @lanes-sh/link                # puts `lanes` on your PATH
$ lanes auth login                             # opens a browser once
$ lanes link profile add personal --workspace local
$ lanes link profile members add --me --profile personal --workspace local
$ lanes link start --profile personal --workspace local
ok    serving http://127.0.0.1:7337/mcp
      profiles: personal
```

Then, in another shell:

```console
$ lanes link mcp add --profile personal --workspace local     # every agent installed; or name one: claude, codex
ok    registered lanes-link with Claude Code (user scope)
ok    registered lanes-link with Codex
```

Your agents can now use it. Memory, tasks, files, skills, and the vault hold your own material
rather than an account, so they are already there — nothing to connect, no credentials, no browser.
Mail and calendar are the next step. **[Full quickstart →](https://lanes.sh/docs/link/quickstart)**

**Why the sign-in.** A profile declares who may consume it, and there is nothing to check that
against if the endpoint has no idea who is asking. That is a real dependency for a self-hostable
tool and worth stating plainly; what it is not is a dependency per request. The network is needed
to sign in and to refresh, and a machine offline for a day keeps serving. `lanes link token
show` still mints a static token for CI, which has no browser to sign in with.

## What you keep in it

Not "what your agent gets" — the distinction is the whole point. These are yours. An agent is a
visitor to them, and you decide per profile how far in it comes.

| | | Manage it with |
|---|---|---|
| **Connections** | your external accounts — mail, calendar, files, issues | `lanes link connect` |
| **Memory** | what you want remembered between sessions | `lanes link memory` |
| **Tasks** | what you have to do, each with a status | `lanes link tasks` |
| **Assets** | files you want kept, by name | `lanes link assets` |
| **Skills** | your own procedures, handed to an agent as instructions | `lanes link skills` |
| **Identity** | who you are, and the people and companies that recur in your work | `lanes link identity` |
| **Vault** | passwords and API keys, released only where you allow it | `lanes link vault` |

Every one of these except connections arrives switched on: they hold your own material rather than
an account, so there was never anything to authorise. Memory, tasks, and skills are plain Markdown
files and an asset is stored under its own filename, so a text editor and an agent reach the same
bytes. Every one of them belongs to a single profile: what you add under `work` is invisible under
`personal`.

Identity is the one that is read-only by construction. An agent able to rewrite whose name it signs
with would be rewriting the one fact that stops it signing as the wrong person, so you declare it in
a terminal and the endpoint only reads it back.

Which store a thing goes in is the one thing worth knowing. **Memory is what is true, tasks is what
is to be done, assets is a file.** "Remember to chase the invoice" is a task — filed as memory it
becomes a note nothing can ever close. Your agents are told this too.

Keep those two in a private GitHub repository instead of on this machine, and get history, diffs,
and the same notes from anywhere you run this:

```console
$ lanes link knowledge use github --repo <owner/name> --migrate
```

It moves what you have already stored, in one commit, and `lanes link knowledge use local
--migrate` brings it back. Nothing else moves — your credentials and your vault stay where they
are, and there is no setting that would put them in a repository.

## Connect an account

**Over a hundred accounts and services, one command each.** Run it again to add a second mailbox, a
second calendar, a second anything.

| | |
|---|---|
| **Mail, calendar, contacts, files** | Gmail · Google Calendar · Google Drive · Google Docs · Google Sheets · Google Tasks · Google Contacts · iCloud Mail, Calendar, Contacts and Drive · Outlook Mail, Calendar and Contacts · OneDrive · Microsoft To Do · Fastmail · Zoho Mail · Yahoo Mail · Nextcloud · any IMAP mailbox |
| **Work** | Notion · Linear · Slack · GitHub · Asana · Atlassian (Jira, Confluence) · Todoist · ClickUp · monday.com · Shortcut · Miro · Whimsical · Figma · Canva · Calendly · Fireflies · HubSpot |
| **Money** | Stripe · PayPal · Square · Mercury · Ramp · bunq · Paddle · Recurly · Expensify |
| **Build and run** | Sentry · Vercel · Netlify · Cloudflare · Supabase · Neon · Prisma · Heroku · CircleCI · Buildkite · Datadog · Grafana · Better Stack · Rootly · Flagsmith |
| **Content and data** | Contentful · Storyblok · Hygraph · Sanity · Webflow · Wix · Algolia · PostHog · Mixpanel · Amplitude · RudderStack |
| **Everything else** | Reddit · Discord · Dropbox · Box · Airtable · Zapier · Attio · Klaviyo · Salesloft · Vimeo · Mux · Replicate · Apify · Tavily · Bright Data |

**[The full list, with the command for each →](https://lanes.sh/docs/link/connect)**

Most of them need nothing set up. Seventy of them run their own MCP server and offer dynamic client
registration, so `connect` registers us on the spot: browser, approve, done. The rest are one of
three shapes — an app password you issue yourself (iCloud, Fastmail, Gmail over IMAP), a token you
paste (GitHub, Discord), or an OAuth client of your own (Reddit, Microsoft). A few also ask *where*
they are, because the address belongs to the account rather than the vendor — a Nextcloud you run,
or any IMAP server.

**Most of them are also untested**, and the tables say which. A provider marked † validates, generates
tools inside the budget, and answers a probe — but nobody has connected it to a real account yet, and
that is the part only a real account proves. See
[`src/providers/README.md`](src/providers/README.md) for what that means and how the list is kept.

Three things worth knowing up front. `lanes link connect icloud` sets up Mail, Calendar, and
Contacts together, because one app-specific password covers all three — and `lanes link connect
fastmail` does the same for Fastmail's three. Reddit is the one that does
need an app of your own — it rate-limits per client id, so a shared client would mean strangers
spending your budget. Google and Slack need no
OAuth client of your own: both authorise against the one Lanes operates, so there is no console to
visit — for Google, add `--own-client` if you would rather register your own, or take a service
account key or an app password over IMAP where you would rather nothing expired. And GitHub takes a
token you paste rather than a browser sign-in, because it will not register a client for us. And
bunq — which wants a key from inside its app rather than a console at all — is the one that can move
money, and it says so: its payment tool executes immediately and is not reversible. Set a spending
limit on the API key while you are in there, and read
[Connecting bunq](https://lanes.sh/docs/link/bunq) before connecting it.

Full guide — what each one gives your agent, what it needs, and adding your own:
**[Connect your accounts](https://lanes.sh/docs/link/connect)**. How the provider layer works, and
the whole inventory by connector and credential type:
**[src/providers/README.md](src/providers/README.md)**.

## Run it anywhere

The same code, the same config, in all three. Only the storage adapters change.

| | **Local** | **Self-Hosted** | **Lanes Cloud** |
|---|---|---|---|
| Runs on | your machine | your GCP project, on Cloud Run | managed for you |
| Needs | Bun, nothing else | a Google Cloud billing account | — |
| Set up with | `lanes link start` | `lanes link deploy` | [join the waitlist](https://lanes.sh/forms/f/a46d8b45-4759-485b-841c-d117a823b645) |
| Reachable from | that machine | anywhere, including your phone | anywhere |
| Status | ready | ready | **coming soon** |

**Local** is the fastest way to start, and where most people stay. **Self-Hosted** is what you
want if you need to reach it from claude.ai, ChatGPT, or a phone — `lanes link deploy` creates the
project, the bucket, the service account, and the revision on its first run. **Lanes Cloud** is the
managed version; because it is the same data model, a workspace you build today moves across rather
than being rebuilt.
[Join the waitlist](https://lanes.sh/forms/f/a46d8b45-4759-485b-841c-d117a823b645) to hear when it opens.

## Docs

- **[Quickstart](https://lanes.sh/docs/link/quickstart)** — from nothing to a working endpoint
- **[In the Lanes desktop app](https://lanes.sh/docs/desktop/lanes-link)** — the page that drives it
- **[Connect your accounts](https://lanes.sh/docs/link/connect)** — every provider, and what each one needs
- **[Add it to your agent](https://lanes.sh/docs/link/clients)** — Claude Code, Codex, Claude Desktop, claude.ai, ChatGPT
- **[Deploy to your own cloud](https://lanes.sh/docs/link/deploy)** — five commands to a URL
- **[Every command](https://lanes.sh/docs/link/commands)** — arguments and flags, one entry each
- **[Full reference](https://lanes.sh/docs/link)** — architecture, configuration, the CLI, the
  security model, and writing a provider
- **[Decision records](docs/detailed/adr/)** — why each choice was made, kept here with the source

## Security

Lanes Link holds live credentials to your email and documents. The
[security model](https://lanes.sh/docs/link/security) states its limits plainly rather than implying
guarantees the code does not deliver — read it before you trust it with an account. To report a
vulnerability, see [`SECURITY.md`](SECURITY.md); please do not open a public issue.

## License

[Apache-2.0](LICENSE)
