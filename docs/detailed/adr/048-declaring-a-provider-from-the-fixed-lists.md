# ADR-048: A provider is declared by composing the two fixed lists

**Status:** accepted · **Follows from** [ADR-008](008-connectors.md) ·
**Relates to** [ADR-030](030-a-profile-owns-its-skills-and-manifests.md) ·
**Relates to** [ADR-007](007-control-plane-exclusions.md)

## Context

ADR-008 made a provider a declaration rather than a package, and said what that was for:

> The manifest schema is the same whether it arrives as a typed module in `providers/builtin` or
> as YAML in `<workspace>/providers/*.yaml`. That is the point: a service we have never heard of
> is a file, not a pull request.

The mechanism has been true since. `loadProfileProviders` reads
`data/<profile>/providers.d/*.yaml`, runs it through the same `defineProvider` a built-in calls at
import, and registers it into the same registry with `origin: 'workspace'`. `connect` says so out
loud in a comment — *a custom provider must be as connectable as a built-in* — and it is.

What was missing was the way in. To reach that mechanism an operator had to know a directory no
command names, write YAML against a schema they would read in the source, and satisfy fourteen
cross-field rules that only announce themselves by refusing. Two commands were promised in
docstrings and never existed: `lanes link provider new`, named as the writer of the scaffold in
`providers/custom/load.ts`, and `lanes link provider list`, named in `registry.ts` as the reason
`origin` is recorded at all. And the one message that would have pointed somebody at the
directory named `<workspace>/providers/`, which nothing has ever read.

So the gap was never the design. It was that the most scalable thing in the system was the least
reachable.

## Decision

**`lanes link connect custom <id> --connector <kind> --auth <method>` declares a provider by
composing the two closed unions a provider is made of, writes the manifest, and connects it.**

Those unions are the whole surface: five connectivity types an operator can declare (`mcp`,
`http`, `imap`, `dav`, `fs`) and seven credential types (`none`, `bearer`, `api_key`, `header`,
`basic`, `oauth`, `strategy`). Thirteen of the thirty-five pairs are legal; `defineProvider` closes
the rest, each for a stated reason. Nothing is bolted on here for a service that fits no pair — that
is a member missing from one of the lists, which is a folder and a schema entry away, and
[`connectivity-coverage.md`](https://lanes.sh/docs/link/connectivity-coverage) is the standing account of which.

`strategy` is offered rather than withheld, and it is the one that most needed deciding. A strategy
names code that travels on a provider's definition rather than in a global registry
([ADR-046](046-an-auth-strategy-belongs-to-its-provider.md)), so a declaration-only manifest reaches
one *by name* — and doing that is the only way to point a connection at a vendor's sandbox, because
a built-in manifest's `options` are not the operator's to edit. Whether the name resolves is the
registry's question and not this command's: it has no registry to ask, `strategyFor` looks at the
manifest's own definition and then at every registered provider's, and `refuseStrategy` is what says
a name reaches nothing. So `--strategy <name>` is passed through and the answer arrives from the
place that has it.

Four things follow from it, and each is the decision rather than an implementation detail.

**The flags are a projection of the two schemas, not a mirror of them.** `defineProvider` requires
fields nobody should have to type. `setup.prompts` is mandatory for every credential type that is
*asked for* rather than granted — without one `ensureStaticCredential` throws, so a manifest with
no prompt is a provider that cannot be connected at all. `identity` decides whether a connection
can be labelled with the account it belongs to. And a manual OAuth client needs two prompt keys
and two credential refs whose exact spelling is read back by literal string in `declareOwnClient`
and `resolveOAuthClient`; misspell one and the manifest validates, two secrets are collected and
stored, and *then* it refuses — after the operator has been through a vendor console. All three
are derived, and the test asserts the OAuth keys against `declareOwnClient`'s own output rather
than against a second copy of the strings.

**No flag carries a credential.** The repository already decided this for `secrets set`, which
reads stdin because an argument is in shell history, in `ps` output while the command runs, and in
any transcript of the session. The consequence here is better than a rule: the command's job is to
write a manifest whose prompts declare what to ask for, and the existing connect path asks. So it
handles no secrets, and there is no second implementation of anything about them.

**A combination that validates and cannot run is refused before the write.** Four of these are
invisible to the schema. A `strategy` on anything but an `http` connector — it signs or negotiates an
HTTP request and the other four connectors make none it could sign, which no rule in `defineProvider`
states because each of them already refuses `strategy` for its own reason. And three about OAuth: an `http` connector with dynamic registration (a REST API publishes no
registration endpoint, so there is no client to authorise with), half a pair of OAuth endpoint URLs
(`authorise` takes the direct path only when both are present, so one alone is ignored on `mcp` and
fatal on `http`), and dynamic registration alongside both URLs (declaring them takes an `mcp`
connector off the SDK's own flow and onto ours, and ours needs a client to present — ADR-040). This
is the class worth the most care, because "the manifest is valid" and "the tests pass" are both
true right up until somebody uses it.

**Refusals name the alternative, not the rule.** `defineProvider` says a `dav` connector must
declare `auth: basic`; this says `--auth basic`. The check runs regardless a moment later, so the
duplication buys nothing except the sentence — which is the part somebody acts on.

## The manifest is written before the connect, and survives a failed one

`runConnect` opens the runtime on its first line, and the registry that opening builds is what
reads `providers.d/`. So the file has to exist first; there is no ordering in which the command
declares and connects in one pass and the connect sees a manifest written afterwards.

That means a failed connect leaves a manifest and no connection. This is correct state, not a leak.
It is the documented normal state of a hand-written manifest, `status` reports it, and a re-run is
genuinely a repair — the manifest is registered, the stored credential is found, and the second run
reaches the config write. Rolling it back would delete the operator's authored file because a
browser consent was cancelled, or because a spec URL 404'd, which are the two failures the file
itself is the fix for. So the outcome carries the manifest in `changes` either way, and the retry
line is plain `connect <id>`: the file exists now.

The one thing that must not survive is a *malformed* manifest. `loadProfileProviders` throws for
the whole directory on one bad file, which breaks `connect`, `doctor`, `plan`, `status`, `start`
and `deploy` for that profile — and `check`, whose job is catching exactly this, does not read the
directory at all. So the composed text goes through `parseManifest` — the loader's own gate,
entropy check included — before anything is written, and the write is a temp file and a rename.

## Rendering the declaration, not the validated manifest

Writing what `defineProvider` returns would have been the obvious thing, and it does not work.

`defineProvider` applies every schema default. Writing those back freezes them: a manifest saying
`port: 993` stops following the default if it ever changes, and a re-run diffs against a file full
of values nobody chose. Worse, the file would not load. `auth.refresh_token` defaults to
`required`, which puts a key ending in `_token` into the document — and the entropy check guarding
a manifest refuses any such key that is not a `_ref`. The command would have written a file
rejected the next time anything read it.

So the command renders the *declaration* — only the fields the answers settle, plus what the
derivation must add — and validates it separately. The round-trip test is what found this, and it
is the assertion the design rests on: the text written is re-read by the exact code the loader
runs and comes back the same manifest.

It also records a real limit, in [`connectivity-coverage.md`](https://lanes.sh/docs/link/connectivity-coverage): a YAML
manifest cannot currently set `refresh_token: optional`, which a vendor issuing long-lived tokens
without a refresh token needs. Nothing here works around it.

## `custom` cannot be a provider id

It is the second word of this command's own grammar, so such a provider could be declared,
registered, and then never connected — `lanes link connect custom` would always mean the command.

Refused in the command, and again in `buildRegistryWithWorkspace` so a file written by hand says
why rather than being quietly unreachable. Deliberately *not* through
`RESERVED_PROVIDER_IDS`: that list is the owner layer's, it is surfaced to an agent as the owner
providers present in a profile, and the CLI registry passes `allowReserved: true` — so it would
not have fired here anyway.

## Alternatives considered

**`lanes link provider new`, then `connect`.** The spelling the docstrings promised, and the
cleaner separation — a manifest is config, a connection is a credential, and ADR-007 keeps those
apart. Rejected because the separation is ours and the cost is the operator's: two commands to
learn and two to type for one intention, where the second is fully determined by the first. The
seam still exists in the code, `runConnect` is exported for it, and `provider list` remains worth
building for a different reason — reading what a profile has, which nothing does today.

**Reusing `manifestTemplate` as the writer.** It is teaching material: it names a plausible vendor,
fills every field with an example, and explains each in a comment. Substituting values into it
would leave the comments describing a different provider than the values beside them, and every
optional field the operator declined sitting in the file as a value that now *is* declared. It
stays exactly as it is, for the hand-write path.

**A generic `--field key=value` escape hatch.** Rejected as the thing this ADR exists to avoid. A
field that no connectivity type declares is not a gap in this command; it is a gap in a schema, and
routing around it would make the fixed lists advisory.

## Consequences

A service reachable by one of the five protocols and one of the six credential types is now one
command. What that command cannot express is exactly what the two unions cannot express, which is
the property worth having — the coverage page is the list, and each entry there names its cost.

The command is also the reason two things adjacent to it had to be fixed first: manifests were not
read at all on a deployed endpoint (ADR-049), and `identity: { kind: http }` could never work for
the commonest custom shape there is. Both were pre-existing and neither was visible until something
made declaring a provider easy.
