# ADR-037: A command names the profile and target it acts on, or it does not run

**Status:** accepted · **Amends** [ADR-004](004-declarative-config-imperative-cli.md) · **Withdraws part of** the resolution chain described in `src/profile/workspace.ts`

## Context

An operator ran two commands:

```console
$ lanes link profile add work --target cloud
ok    created profile work
      config  ~/.lanes-link/profiles/work.yaml
      port    7338

$ lanes link connect gmail --profile work --target cloud
error  Target "cloud" is not declared in this profile (have: local)
```

The first command accepted `--target`, said `ok`, and dropped it. `main.ts` built an options
literal for that one case and never spread the global flags into it, and `newProfileTemplate`
was a string with `targets:` and `local:` written into it — so even a forwarded flag would have
had nothing to act on.

That is a one-line bug and a one-line fix. What this ADR is about is the second line of the
output: why an ignored flag produced a *successful* command, and why the failure surfaced on the
next one instead.

Resolution was a chain. `--profile`, then `LANES_LINK_PROFILE`, then `default_profile`;
`--target`, then `LANES_LINK_TARGET`, then `instance.default_target`. A dropped flag therefore
did not fail. It fell through to the next source down and the command worked — against something
else. The mistake became visible one command later, from a different source, with nothing on
screen connecting it to its cause.

The chain was a deliberate design, and the reasoning is still in the file it lived in:

> There is deliberately no sticky `lanes link use` that persists a *hidden* current selection.
> Persisted context state is the standard way operators run destructive commands against the
> wrong target, and the version of it that bites is the dotfile nothing prints.
>
> So both ways of not retyping a flag are visible ones. `export LANES_LINK_PROFILE=work` and
> `export LANES_LINK_TARGET=cloud` live in the shell, where `env` shows them; `default_profile`
> and `instance.default_target` live in files the operator reads and `check` validates […]
> Every command prints which of the four it landed on and where that came from.

## Decision

**`--profile` and `--target` are required flags on every command that resolves them.**
`LANES_LINK_PROFILE`, `LANES_LINK_TARGET`, `default_profile` and `instance.default_target` are
still parsed and are no longer read.

Three tiers, because uniformity here would be its own mistake:

| Tier | Commands |
|---|---|
| Neither | `help`, `version`, `update`, `profile list`, `profile add`, `mcp list`, `mcp skill`, `vault key generate` |
| `--profile` only | `check`, `config show`, `policy list`, `target list`, `target show`, `secrets push`, `profile remove` |
| Both | everything that opens a target's adapters or acts against its endpoint |

`check`, `config show` and `policy list` are target-independent — a YAML file, the whole of it,
and a policy block declared once for every target. Demanding a target there is the ceremony that
teaches people to type `--target local` without reading it, which is how a required flag stops
being a guard. `target list` is the command you run to find out what to pass, so requiring the
answer as input would be circular.

## Why the first paragraph of the old reasoning is the argument *for* this

The withdrawn half is the second paragraph, not the first. "Persisted context state is the
standard way operators run destructive commands against the wrong target" is exactly right, and
this decision takes it one step further than it went: the problem is not that the wrong source
won, it is that *any* source won.

What did not survive is the conclusion that visibility was a sufficient mitigation. Two pieces
of evidence, both from this repository:

1. **The visible line is a dim grey one.** `announce` printed the resolved profile and target
   above every command. It is the same line `commands/target.ts` already worries about — its own
   comment says a line printed unconditionally is one people stop reading, which is why the
   `LANES_LINK_TARGET` warning beside it was made conditional.
2. **A fallback made an ignored flag survivable.** This is the failure above, and no amount of
   printing addresses it. A command that refuses cannot be wrong quietly.

## What is deliberately not in scope

**The workspace root keeps its chain** — `LANES_LINK_HOME`, then an ancestor holding
`lanes-link.yaml`, then `~/.lanes-link`. Three reasons, recorded so this is not reopened:
getting it wrong yields "no profiles here" rather than an action against the wrong account, so
it fails loudly and harmlessly where the other two failed quietly; it is the only channel a
container has for its bucket (ADR-023), where there is no argv to put a flag on; and the
ancestor walk is what makes a per-repository workspace work at all. A `--home` flag would also
be a third required flag on every command.

**`container.ts` translating environment into flags is not a loophole.** The container is a
separate entrypoint, not the CLI, and by the time `openRuntime` is called the selection is
explicit. It refuses a missing `LANES_LINK_PROFILE` in its own voice rather than passing along a
CLI-shaped "pass --profile" to a log with no command line to pass it to.

**The contract major is not bumped.** The contract exists to refuse a document whose *meaning*
cannot be read. No existing file's meaning changed — two keys stopped being consulted — and no
file needs editing.

## Consequences

**Both keys stay in the schema, unread and reported.** Stripping them would be silently safe:
zod drops unknown keys, and every existing config would still parse. That is the argument
against it. A key that is stripped cannot be reported, and an operator looking at
`default_target: local` has every reason to believe it still selects something. Declared,
optional and unvalidated is the only combination where every existing file parses, no new file
needs the line, and `check` can say the line is dead.

**`lanes link target use` and `lanes link profile default` are removed.** They wrote keys nothing
reads, and a command that writes a key nothing reads reports success while changing nothing
observable — the failure this ADR exists to remove. Both are kept in the dispatch for one
release as explicit refusals, because falling through to `Unknown: lanes link target use` would
send someone hunting a typo in a command they have run for months.

**`deploy` loses its own inference.** `resolveDeployTarget` picked the target declaring a
`deploy` block: guessing at one, refusing at two, inventing `cloud` at none. That was a defence
against `instance.default_target` being `local` on a scaffolded profile. With the fallback gone
it defends against nothing, and what remained was three behaviours from one command line on the
command that creates cloud resources and rolls a public URL — where `allowUndeclared` means a
mistake is not refused but surveyed, written into the profile, and deployed as a new service.

**Unknown flags are refused.** Required flags make a typo *worse* on their own: `--porfile work`
used to fall through to a default and mostly work, and with a requirement and no allowlist it
produces "--profile is required", naming a flag the operator believes they just passed. The
allowlist is the half of this change that makes the other half survivable.

**Every registered stdio client breaks at spawn**, and there is no in-product mitigation — the
process exits before any MCP handshake. The only lever is the stderr text, so `mcp stdio` prints
the JSON to paste rather than the flag to add, written for the one person who will read it:
somebody looking at a client's log after the server "disconnected".

**Every emitted `lanes link …` in the product had to change.** Most carried neither flag because
a default filled them in. `setup_provider` hands these to an agent, which pastes what it is
given, so a missed one is a paste that refuses — or, for the `secrets set` line, one that writes
a credential into a store the endpoint asking for it does not read. A tier that runs inside the
endpoint keeps no flags at all and stops looking like commands: dispatch holds a config and
therefore a profile, but never a target.

**Ergonomics get worse, and that is the trade.** `lanes link status` becomes `lanes link status
--profile personal --target local`. A shell alias is the operator's business now; the docs say
so rather than apologising for it.
