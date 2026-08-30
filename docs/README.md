# Lanes Link docs

The documentation lives at **[lanes.sh/docs/link](https://lanes.sh/docs/link)**.

| | |
|---|---|
| **[Quickstart](https://lanes.sh/docs/link/quickstart)** | From nothing to a working endpoint |
| **[Connect your accounts](https://lanes.sh/docs/link/connect)** | Every account, and what each one needs |
| **[Add it to your agent](https://lanes.sh/docs/link/clients)** | Claude Code, Codex, Claude Desktop, claude.ai, ChatGPT |
| **[Deploy to your own cloud](https://lanes.sh/docs/link/deploy)** | Five commands to a URL |
| **[Every command](https://lanes.sh/docs/link/commands)** | Arguments and flags, one entry each |

Every page is also served as plain Markdown: add `.md` to the path, for example
[lanes.sh/docs/link/quickstart.md](https://lanes.sh/docs/link/quickstart.md).

## What is still in this repository

| | |
|---|---|
| [`detailed/adr/`](detailed/adr/) | The architecture decision records: why each choice was made, and what it cost |
| [`detailed/init.md`](detailed/init.md) | The original specification, amended to match what was built |

Those are engineering history rather than documentation, so they stay with the source.

## Editing the docs

The pages above are authored in the website repository, under `src/content/docs/link/`. Three test
files here read them, so point them at your checkout when you add a provider, change a config
example, or edit the Google scope justifications:

```console
$ LANES_DOCS_DIR=/path/to/web/src/content/docs/link bun test
```

| | Reads | Checks |
|---|---|---|
| `src/readme.test.ts` | `connect.mdx` | Every provider manifest has a `lanes link connect` command, and the untested markers agree with `untested.ts` |
| `src/profile/docs.test.ts` | `configuration.mdx`, `deployment-cloudrun.mdx`, `creating-a-provider.mdx`, `connectivity-coverage.mdx` | The documented config examples and provider manifests parse against the real schema |
| `src/providers/google/specs/specs.test.ts` | `google-verification.mdx` | The Google scopes the code requests are the ones the page justifies to reviewers |

Without `LANES_DOCS_DIR` those checks skip rather than passing by not looking, which is what happens
in the `ci` workflow: it has no access to the website repository, which is private.

They are run instead by the **`docs` workflow**, daily and on demand, against the pages as published
on lanes.sh. That is the honest subject anyway, since what matters is whether the documentation a
reader receives still names everything this code ships. If it goes red after you add a provider, the
website side has not caught up yet.
