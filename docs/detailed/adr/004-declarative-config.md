# ADR-004: Declarative config, imperative CLI

**Status:** accepted · **Milestone:** M1

## Decision

The config file is the source of truth for what exists. The credential store holds values. The
database holds only runtime state.

| Config | Credential store | Database |
|---|---|---|
| contract, profile, targets, connections, providers, policy, limits, OAuth app refs | refresh tokens, app client secrets, the profile token | connection status, provider state, cursors, audit events |

**Config never contains a credential value** — only `_ref` pointers.

## Why declarative

The M2 target scales to zero. Administering a remote instance by shelling into a container or
connecting to its database is not workable, so declared config plus a reconcile step on boot removes
the problem entirely and makes the whole setup diffable and reproducible.

Config flows one way: local CLI to instance. A deployed instance never mutates its own configuration
and exposes no administrative API, so there is no admin surface on the public URL to attack.

## Why an imperative CLI on top

Declarative config and an imperative CLI are not opposites. `lanes link connect` is a convenience that
produces a correct file, so nobody has to hand-edit YAML, while the file remains the single source of
truth. Both paths are supported and neither is second-class — which is why CLI edits go through the
YAML Document API and preserve comments and key ordering. A CLI that reformats the file makes the
file hostile to hand-editing, which then makes the CLI mandatory.

Every write validates the rendered document first and lands through a temporary file. A config left
invalid by a failed command is worse than a command that refuses to run.

## Validation order

Not arbitrary:

1. **Contract major**, before anything else. Under an unknown major we cannot claim to know what the
   rest of the document means, and this file governs authorization — so it fails closed rather than
   loading best-effort.
2. **Secret detection**, on the *raw* parsed object rather than the schema output. Zod strips unknown
   keys, so a credential parked under a misspelled key would otherwise pass validation invisibly.
3. **Schema shape.**
4. **Referential integrity.** A policy rule naming an unknown connection *fails*, because a rule that
   silently grants nothing looks identical to a working one until someone relies on it.

The secret detector is deliberately biased toward false negatives: it flags vendor prefixes, private
key blocks, high-entropy blobs, and any key naming a credential that holds a literal instead of a
`_ref`, and tests assert that paths, display names, URLs, and `_ref` values are not mistaken for
credentials. A rule that rejects a legitimate display name makes the tool unusable.

## No ORM

init.md says "Drizzle or similar for typed database access". The schema is four tables and every
query is single-table. `bun:sqlite` directly *is* the "or similar": an ORM would add a dependency and
a migration toolchain to a repository holding live refresh tokens in exchange for nothing this code
needs.
