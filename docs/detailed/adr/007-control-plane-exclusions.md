# ADR-007: Control-plane operations are unreachable from MCP

**Status:** accepted · **Milestone:** M1

## Decision

The following are reachable through the CLI **only**, and must never be exposed as MCP capabilities:

- **Policy changes** — granting or revoking any rule
- **Token management** — minting, rotating, or reading a token value
- **Connection creation and credential writing**, including running the OAuth flow
- **Configuration mutation** of any kind
- **Reading raw credential values**
- **Audit mutation or deletion.** The log is append-only; audit reading is CLI-only in M1

## The unifying principle

Each of these authorises *future* agent behaviour, so the decision itself must originate outside the
agent. A prompt-injected or confused client that could widen its own policy would defeat the entire
authorization layer in one call — and content returned from upstream accounts is explicitly treated
as untrusted, so prompt injection is an expected input, not a hypothetical.

The same principle extends to the deployment. A running instance, local or remote, never mutates its
own configuration and exposes no administrative API. Configuration changes originate from the
operator's CLI and arrive by deployment, so there is no admin surface on the public URL to attack.

## These are walls, not gaps

Anyone auditing the CLI against the MCP surface will find these missing and read them as
capability-parity gaps. **Do not "complete" the parity without revisiting the reasoning here.**

`packages/core/src/control-plane.test.ts` is what keeps that from happening by accident. It asserts:

- No registered capability name matches policy, token, credential, config, connect, or audit
  patterns — and includes a **rogue provider proving the patterns actually bite**, because a guard
  that cannot fail is not a guard.
- The `ProviderContext` surface is *exactly* seven keys. A new key appearing there is a design
  decision, not an implementation detail.
- No provider receives a `Database`, config, policy engine, or registry.
- `credentials` is read-only — `get` and `has`, nothing else — and cannot reach another connection's
  refs, the profile token, or an undeclared app secret.
- The `audit` handle can annotate the invocation in progress but cannot read or mutate the log.

## Enforcement is structural where it can be

Some of these are guaranteed by the *absence* of a capability rather than by a check:

- `AuditStore` has no `update` and no `delete` method. That absence **is** the append-only guarantee,
  enforced by the type system rather than by a database trigger someone can drop.
- `ScopedCredentials` exposes no `set`, `delete`, or `list`. A provider cannot write a credential
  because there is no method that would.
- An out-of-scope credential ref fails identically to a missing one, so the error cannot be used to
  enumerate the store.

## Related: probing must not be an oracle

An unknown capability is refused identically to a denied one, and a tool hidden by policy filtering
reports as "not found" exactly as a nonexistent one does. Otherwise the error message becomes a
capability enumeration oracle for a caller that is not permitted to enumerate.

Because such an attempt never reaches dispatch, `Dispatcher.recordRefusal` records it explicitly —
an agent probing for tools it does not have is precisely what the log exists to capture.
