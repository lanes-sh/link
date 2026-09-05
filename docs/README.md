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
| [`detailed/admission.md`](detailed/admission.md) | Where a vendor admits the client rather than the operator: programmes, catalogues, and waitlists |

Those are engineering history and standing constraints rather than documentation, so they stay
with the source.

## Editing the docs

The pages above are authored in the website repository, under `src/content/docs/link/`. Two test
suites here read them, so point them at your checkout when you change a config example or the
Google scope justifications:

```console
$ LANES_DOCS_DIR=/path/to/web/src/content/docs/link bun test
```

Without it, `src/profile/docs.test.ts` and the verification checks in
`src/providers/google/specs/specs.test.ts` skip rather than passing by not looking.
