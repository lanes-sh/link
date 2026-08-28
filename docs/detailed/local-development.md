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
$ bun link                          # or put this checkout's `lanes` on your PATH
```

`bun link` is what people who installed `@lanes-sh/link` from npm get, pointed at your checkout
instead: it reads the same `bin` entry, so `lanes` runs `bin/lanes`, which runs this tree. Prefer it
over the two lines above once you are running more than one command at a time — and note that it
replaces any published `lanes` on your `PATH` until you `bun unlink`.

Use a throwaway workspace so you never touch a real profile:

```console
$ export LANES_LINK_HOME=/tmp/lanes-link-dev
$ bun run lanes link profile add personal --target local
$ bun run lanes link connect example
$ bun run lanes link start
```

## Pointing the OAuth broker somewhere else

A provider whose manifest declares `auth.broker` — every Google REST provider does — authorises
against a client somebody else operates, and the exchange happens at that operator's origin. For
production that is the right answer and there is nothing to configure. For working *on* the broker
it is not: you want the one on your machine, or the one on stage.

`LANES_LINK_BROKER_ORIGIN` replaces the origin and leaves the path alone, for every provider at
once:

```console
$ export LANES_LINK_BROKER_ORIGIN=http://127.0.0.1:8080
$ bun run lanes link connect gmail
warn  LANES_LINK_BROKER_ORIGIN is set — the authorization code will be exchanged at
      http://127.0.0.1:8080, not by Lanes.
```

It reaches both callers, because both read the same manifest field: the CLI performing the first
exchange, and the endpoint refreshing while it serves.

Three things it deliberately will not do:

- **Fall back when the value is malformed.** It throws. A variable that is ignored when wrong is how
  you send a real authorization code to production while believing you are testing locally.
- **Accept `http` for anything but loopback.** Off this machine that puts an authorization code on
  the wire in the clear. Use `https` for a remote broker.
- **Keep a path.** `https://stage.example.com/v9/nope` becomes `https://stage.example.com`. The
  provider owns its path; two places deciding where `/exchange` lives would disagree eventually.

The warning above is the point of the feature as much as the redirect is — an override left
exported in a shell is otherwise invisible.

## Opening a different Lanes build

`lanes link desktop` opens `lanes://settings?page=integrations-link`, and macOS routes a scheme to
exactly one bundle. The released app registers `lanes`; a local debug build of the app registers
`lanes-dev` and Lanes Stage registers `lanes-stage`, so testing against either means naming it:

```console
$ LANES_LINK_APP_SCHEME=lanes-dev bun run lanes link desktop
```

A debug build has to be a real `.app` before LaunchServices will route to it — the raw binary a
`bun run app` produces has no `Info.plist` and never sees a URL click. The app repository's
`docs/development/deep-links.md` has the `tauri build --debug --bundles app` and `lsregister` steps.

`--print` needs none of that, and is the cheaper check when what you are testing is this side:

```console
$ bun run lanes link desktop --print
lanes://settings?page=integrations-link
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
