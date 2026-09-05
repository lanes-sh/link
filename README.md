# Lanes Link

[![npm version](https://img.shields.io/npm/v/%40lanes-sh%2Flink?style=flat-square&color=black&label=npm)](https://www.npmjs.com/package/@lanes-sh/link)
[![license Apache-2.0](https://img.shields.io/github/license/lanes-sh/link?style=flat-square&color=black)](LICENSE)
[![ci](https://img.shields.io/github/actions/workflow/status/lanes-sh/link/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/lanes-sh/link/actions/workflows/ci.yml)

**One endpoint you own, holding everything your agents need to know you: connections, memory, tasks, files, contacts, and secrets.**

Connect your mail, calendar, files and notes once. Every agent you use, Claude, ChatGPT, and
anything else that speaks MCP, reaches all of it through that one endpoint. Change your AI and
you keep your context, because none of it ever lived in the agent.

![Left: every agent wired directly to every account, each line crossing the others. Right: the same three agents reaching one Lanes Link endpoint, which fans out to Gmail, GitHub, Slack, memory, skills, and a task list through an Access Profile named engineering.](docs/images/lanes-link-hero.png)

## Quickstart

Needs [Bun](https://bun.com) 1.3.11+ and a Lanes sign-in.

```console
$ bun install -g @lanes-sh/link
$ lanes auth login
$ lanes link profile add personal
$ lanes link profile members add --me --profile personal
$ lanes link start
ok    serving http://127.0.0.1:7337/mcp
      profiles: personal
```

Leave that running. In a second shell, point every agent you have installed at it:

```console
$ lanes link mcp add
ok    registered lanes-link with Claude Code (user scope)
ok    registered lanes-link with Codex
```

Your memory, tasks, files, skills, entities and vault work now, with nothing to authorise. Mail and calendar are
the next step: `lanes link connect gmail`.

**[Full quickstart](https://lanes.sh/docs/link/quickstart)**

## Why

- **Connect once, use everywhere.** No per-agent integrations, no re-authorising every new tool.
- **You decide what agents can touch.** Permissions default to deny, and the runtime enforces
  them rather than asking the model to behave.
- **Work and personal never mix.** Separate profiles, separate credentials, separate stores.
- **Every call is recorded.** An append-only log of what was reached, and what was refused.
- **It is yours to move.** Plain files on your own disk, readable in an editor and portable to
  another machine. There is no export to ask for.

## What people use it for

- **A personal assistant on your phone.** A deployment is a URL, so the claude.ai or ChatGPT app
  reaches your mail, calendar and files from anywhere. This is the one case that needs [your own
  cloud](#run-it-anywhere); everything else here works on your machine.
- **Inbox triage you sign off on.** An agent searches, reads, labels and composes, and saves a
  draft for you to send rather than sending it.
- **Coding agents that start from your context.** Claude Code and Codex reach the same Linear
  issues and Notion pages you do, so a session begins from what you already know.
- **One set of notes behind every agent.** What Claude Code writes down, claude.ai reads back.
- **A to-do list your agents share.** "Remind me to chase the invoice" lands somewhere with a
  status, so whichever agent you talk to next knows it is still open.
- **Your own procedures, followed rather than guessed.** How a standup update reads, where an
  invoice gets filed, who gets cc'd. Written once, and every agent follows the same one.

## What you keep in it

Not "what your agent gets". These are yours, and you decide per profile how far in a visitor
comes.

| | | Manage it with |
|---|---|---|
| **Connections** | your external accounts: mail, calendar, files, issues | `lanes link connect` |
| **Memory** | what you want remembered between sessions | `lanes link memory` |
| **Tasks** | what you have to do, each with a status | `lanes link tasks` |
| **Assets** | files you want kept, by name | `lanes link assets` |
| **Skills** | your own procedures, handed to an agent as instructions | `lanes link skills` |
| **Identity** | who you are, so an agent signs off as you | `lanes link identity` |
| **Entities** | the people and companies you deal with, so an agent looks an address up rather than recalling one | `lanes link entities` |
| **Vault** | passwords and API keys, released only where you allow it | `lanes link vault` |

Everything except connections arrives switched on, because it holds your own material rather
than an account. Memory, tasks and skills are plain Markdown, and an asset keeps its own
filename, so a text editor and an agent reach the same bytes. Each belongs to one profile: what
you add under `work` is invisible under `personal`.

**Memory is what is true, tasks is what is to be done, assets is a file.** "Remember to chase
the invoice" is a task. Filed as memory it becomes a note nothing can ever close. Your agents
are told this too.

Keep memory and skills in a private GitHub repository instead, and get history, diffs, and the
same notes from anywhere you run this:

```console
$ lanes link knowledge use github --repo <owner/name> --migrate
```

Credentials and the vault stay where they are. There is no setting that would put them in a
repository.

## Connect an account

**Over a hundred accounts and services, one command each.** Run it again to add a second
mailbox, a second calendar, a second anything.

| | |
|---|---|
| **Mail, calendar, contacts, files** | Gmail · Google Calendar · Google Drive · Google Docs · Google Sheets · Google Tasks · Google Contacts · iCloud Mail, Calendar, Contacts and Drive · Outlook Mail, Calendar and Contacts · OneDrive · Microsoft To Do · Fastmail · Zoho Mail · Yahoo Mail · Nextcloud · any IMAP mailbox |
| **Work** | Notion · Linear · Slack · GitHub · Asana · Atlassian (Jira, Confluence) · Todoist · ClickUp · monday.com · Shortcut · Miro · Whimsical · Figma · Canva · Calendly · Fireflies · HubSpot |
| **Money** | Stripe · PayPal · Square · Mercury · Ramp · bunq · Paddle · Recurly · Expensify |
| **Build and run** | Sentry · Vercel · Netlify · Cloudflare · Supabase · Neon · Prisma · Heroku · CircleCI · Buildkite · Datadog · Grafana · Better Stack · Rootly · Flagsmith |
| **Content and data** | Contentful · Storyblok · Hygraph · Sanity · Webflow · Wix · Algolia · PostHog · Mixpanel · Amplitude · RudderStack |
| **Everything else** | Reddit · Discord · Dropbox · Box · Airtable · Zapier · Attio · Klaviyo · Salesloft · Vimeo · Mux · Replicate · Apify · Tavily · Bright Data |

Most need nothing set up: `connect` opens a browser, you approve, and it is live. The rest ask
for an app password, a token you paste, or an OAuth client of your own, and the guide says which
is which.

**[Connect your accounts](https://lanes.sh/docs/link/connect)** covers every provider, what each
one gives your agent, and how to add one that is not on the list.

Two worth knowing before you connect them. **bunq** can move money: its payment tool executes
immediately and is not reversible, so set a spending limit on the API key and read [Connecting
bunq](https://lanes.sh/docs/link/bunq) first. **Most providers are untested** against a real
account, and the tables mark which with a †. See [`src/providers/README.md`](src/providers/README.md)
for what that means.

## Run it anywhere

The same code and the same config in all three. Only the storage adapters change.

| | **Local** | **Self-Hosted** | **Lanes Cloud** |
|---|---|---|---|
| Runs on | your machine | your GCP project, on Cloud Run | managed for you |
| Needs | Bun, nothing else | a Google Cloud billing account | a Lanes Pro plan |
| Set up with | `lanes link start` | `lanes link deploy` | [join the waitlist](https://lanes.sh/forms/f/a46d8b45-4759-485b-841c-d117a823b645) |
| Reachable from | that machine | anywhere, including your phone | anywhere |
| Status | ready | ready | **coming soon** |

Start local; most people stay there. Go self-hosted when you need to reach it from claude.ai,
ChatGPT or a phone: `lanes link deploy` creates the project, the bucket, the service account and
the revision on its first run.

## Docs

| | |
|---|---|
| **[Quickstart](https://lanes.sh/docs/link/quickstart)** | From nothing to a working endpoint |
| **[Connect your accounts](https://lanes.sh/docs/link/connect)** | Every provider, and what each needs |
| **[Add it to your agent](https://lanes.sh/docs/link/clients)** | Claude Code, Codex, Claude Desktop, claude.ai, ChatGPT |
| **[Deploy to your own cloud](https://lanes.sh/docs/link/deploy)** | Five commands to a URL |
| **[Every command](https://lanes.sh/docs/link/commands)** | Arguments and flags, one entry each |
| **[In the Lanes desktop app](https://lanes.sh/docs/desktop/lanes-link)** | The page that drives it |
| **[Full reference](https://lanes.sh/docs/link)** | Architecture, configuration, security, writing a provider |

## Security

Lanes Link holds live credentials to your email and documents. The [security
model](https://lanes.sh/docs/link/security) states its limits plainly rather than implying
guarantees the code does not deliver. Read it before you trust it with an account.

To report a vulnerability, see [`SECURITY.md`](SECURITY.md). Please do not open a public issue.

## Notes

**Why the sign-in.** A profile declares who may use it, and the endpoint cannot check that
against anything if it does not know who is asking. The network is needed to sign in and to
refresh, not per call, so a machine offline for a day keeps serving.

**Why members is not optional.** An empty members list means nobody, not everybody. The profile
you just created reaches no caller until you are on it.

**Why `mcp add` names no profile.** One endpoint serves every profile in the workspace, and each
call names one in its `profile` argument, so registering is about the endpoint. Which profiles a
client actually reaches is decided when its owner signs in: every profile whose `members:` lists
them, and no others. For a runner with no browser, `lanes link token issue --me` mints a static
token that reaches exactly what its subject is a member of.

**Why no `--workspace` flag.** `local` is the default in a fresh config. Commands that publish or
destroy (`deploy`, `sync`, `secrets push`, `profile remove`, `disconnect`, `token rotate`) refuse
the default and make you type the name.

**Where the decision records live.** [`docs/detailed/adr/`](docs/detailed/adr/), kept with the
source as engineering history rather than documentation.

## License

[Apache-2.0](LICENSE)
