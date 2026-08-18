# Lanes Link docs

Four short guides. Read them in order the first time; after that, go straight to the one you need.

| | |
|---|---|
| **[Quickstart](quickstart.md)** | From nothing to a working endpoint, in four commands |
| **[Connect your accounts](connect.md)** | Every provider, what each one needs, and how to add your own |
| **[Add it to your agent](clients.md)** | Claude Code, Codex, Claude Desktop, claude.ai, ChatGPT, and anything else |
| **[Deploy to your own cloud](deploy.md)** | Five commands to a URL you can reach from a phone |

## Reference

The full documentation lives in [`detailed/`](detailed/). It is longer on purpose — it records why
each decision was made, not just what to type.

| | |
|---|---|
| [`workflow.md`](detailed/workflow.md) | Every CLI command, end to end |
| [`configuration.md`](detailed/configuration.md) | The profile file, policy grammar, targets, environment variables |
| [`providers.md`](detailed/providers.md) | Every capability, what it does, and what its audit entries withhold |
| [`architecture.md`](detailed/architecture.md) | How it fits together, and the dispatch path a call takes |
| [`security.md`](detailed/security.md) | The threat model and the guarantee table |
| [`deployment-cloudrun.md`](detailed/deployment-cloudrun.md) | Cloud Run in full: cold starts, scaling, IAM, the image |
| [`setup/google.md`](detailed/setup/google.md) | Registering your own Google OAuth client, step by step |
| [`setup/icloud.md`](detailed/setup/icloud.md) | One app-specific password for Mail, Calendar, and Contacts |
| [`creating-a-provider.md`](detailed/creating-a-provider.md) | Add your own integration |
| [`local-development.md`](detailed/local-development.md) | Working on Lanes Link itself |
| [`adr/`](detailed/adr/) | Architecture decision records |
| [`init.md`](detailed/init.md) | The original specification, amended to match what was built |
