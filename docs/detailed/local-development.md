# Local development

## Requirements

**Bun 1.3.11+** (pinned in `.bun-version`). Nothing else — there is no build step; Bun runs
TypeScript directly.

```console
$ bun install
$ bun test
$ bun run typecheck
```

## Running the CLI from source

```console
$ bun run lanes link <command>      # via the root script
$ bun run src/cli/lanes.ts link …  # directly
```

Use a throwaway workspace so you never touch a real profile:

```console
$ export LANES_LINK_HOME=/tmp/lanes-link-dev
$ bun run lanes link profile add personal --default
$ bun run lanes link connect example
$ bun run lanes link start
```

## Layout

Dependencies run one way: infrastructure interfaces → provider SDK → core → mcp → server/cli.
Nothing above imports a backend directly. See [`architecture.md`](architecture.md).

Bun installs with the **isolated linker**, so each package sees exactly the dependencies it declares.
If an import resolves in your editor but fails at runtime, the package is missing a dependency entry
rather than the import being wrong.

## Bun-specific code

Confined on purpose:

- `src/server/index.ts` (`Bun.serve`)
- `src/deployments/adapters/s3.ts` (`Bun.S3Client`)

Everything else is portable TypeScript. Keep it that way. `bun:sqlite` used to head this list and
no longer appears anywhere: state and the log are objects in a `BlobStore`, so the local target
opens no database at all.

## Adding a dependency

```console
$ bun add <package>
```

`bunfig.toml` sets `minimumReleaseAge = 604800`, so bun resolves to the newest version at least seven
days old rather than to `latest`. That is intentional: the common npm attack publishes a compromised
version and yanks it within hours. If you need a newer one for a security fix, install the exact
version explicitly and say why in the commit message.

Before adding anything, consider whether it is worth it. This repository holds live refresh tokens,
and the runtime dependency set is deliberately small.

```console
$ bun pm scan          # lockfile CVEs
```

## Testing

`bun:test`. Tests live beside the code as `*.test.ts`.

Test-only helpers are behind separate entry points so application code cannot reach them by accident:

```ts
import { createMemoryState, createMemoryCredentials } from '#stores/state/testing.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
```

Server tests run a **real HTTP server on a real port** rather than mocking the transport, because
what is worth proving is what an agent actually sees. `src/server/harness.ts` starts a fully
wired profile and speaks the 2026-07-28 wire format; note that the revision requires `Mcp-Method`
(and `Mcp-Name`) headers matching the body, and rejects requests where the two disagree.

Write the test that would have caught the bug. Several real defects in this codebase were found by
tests written before the fix — a scoped store throwing synchronously from an async interface,
workspace discovery treating every path as existing, and an unadvertised-tool attempt leaving no
audit trace.
