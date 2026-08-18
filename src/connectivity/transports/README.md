# Connectivity types

One folder per way of reaching a service. A provider declares exactly one in its
manifest's `connector.kind`; how it *authenticates* is the other axis entirely
(`../auth/`).

| Folder | `connector.kind` | In plain words |
|---|---|---|
| `http/` | `http` | a REST API, described by an OpenAPI document |
| `mcp/` | `mcp` | an upstream MCP server, proxied |
| `imap/` | `imap` | a mailbox, over IMAP4rev1 and SMTP |
| `dav/` | `dav` | calendars and contacts, over CalDAV and CardDAV |
| `fs/` | `fs` | a directory on the machine this runs on |
| `local/` | `local` | our own code — `example`, and the owner layer |

The folder is named for the `kind:` an operator writes in YAML rather than for
the friendlier word, because a second name for the same thing is exactly the
confusion this layout is meant to remove. "api" is `http/`.

## The rule

**Protocol code, not vendor code** (ADR-008). Nothing in here may know that
iCloud exists. Where a vendor genuinely behaves differently, the difference is a
field on that transport's schema in `../manifest/connector.ts`, set by the
provider that needs it — see `fs`'s `placeholder_suffix` and `dav`'s
`max_range_days`.

## Adding one

A folder here, a member of `connectorSchema` in `../manifest/connector.ts`, and
a case in `factory.ts`. A transport implements `Connector`: `discover()` says
what the connection exposes, `invoke()` runs one operation, and `identify()` is
optional.
