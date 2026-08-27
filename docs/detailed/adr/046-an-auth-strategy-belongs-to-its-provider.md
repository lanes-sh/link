# ADR-046: An auth strategy belongs to its provider, and its session is state

**Status:** accepted · **Milestone:** M6

[ADR-008](008-connectors.md) reserved one place for per-vendor code — `AuthStrategy`, auth only,
roughly 150 lines — and named bunq as the case that would need it. The seam was typed and left
throwing. bunq is now built, and building it settled two questions the seam had left open.

## Where the code lives

**A strategy is carried by the `ProviderDefinition` that needs it, not registered in a table the
runtime searches.**

The alternative was a registry under `connectivity/auth/strategy/`, one folder per vendor,
populated at startup. It reads naturally — the auth README's own table lists `strategy/` beside
`bearer/` and `oauth-authcode/`, so a folder there looks like where the code goes.

It is the wrong place, and `architecture.test.ts` says why. The rule that no vendor name appears in
the code a request passes through covers `connectivity/`, and a folder of vendor implementations
inside it would be a standing exception to the rule that component exists to keep. The rule is now
enforced for bunq too — `bunq` was added to the `VENDORS` pattern in the same change, which is what
makes the placement checked rather than merely intended. One error message had to give up naming a
vendor to make that pass, which is the rule doing its job.

So `connectivity` keeps the seam and learns nothing: `strategyFor` resolves the strategy a manifest
declares from the definition beside it, and refuses when the two disagree. The implementation is
`providers/bunq/strategy/`, where every other thing about bunq already is. Adding a provider stays
what ADR-008 made it — a folder and a line in `providers/index.ts` — even when the provider needs
code.

## Where the session lives

**Durable credentials go to the credential store during `setup`. The session token goes to
`state`.**

This looks like a weakening and is not a choice. `AuthStrategyContext.write` is absent outside
`setup` by design, and `rotatableCredentialRefs` grants a deployed revision write access on nothing
for a non-OAuth provider — so a per-request handshake *cannot* write a credential, on the target
where it would matter. Two independent parts of the system already said no.

`state` is where it belongs anyway. `stores/state/index.ts` describes its contents as "connection
status, token expiry, cursors, provider state", all of it rebuildable, and a bunq session is
exactly that: reconstructible from the API key, revocable from the app, and expiring within a week
regardless.

What forces it to be *shared* state rather than per-instance memory is a rate limit. bunq allows
**one `/session-server` call per thirty seconds**. A deployed endpoint that opened a session per
cold start would spend a burst of instances being refused, so the token has to survive in a place
every instance can read.

The honest cost: on a deployed target `state` is the blob store, which is weaker than the Secret
Manager the durable half sits in. It is accepted because of what the two halves are. The private
key and installation token are the durable identity of this client and cannot be reissued without
the operator; the session is a week-long bearer token that any instance can mint again from a
credential it already holds.

## Consequences

**A strategy reads its host from the manifest, not from an option.** bunq's sandbox is a different
host, and the first attempt made that a `sandbox: true` option with `authorize` rewriting the
request origin to match. That is a second source of truth for something `base_url` already states,
and the two can disagree — a manifest pointed at the sandbox but missing the flag would have spent
against production. Deriving both the handshake host and the request from `base_url` makes the
disagreement impossible instead of documented. `auth.options` remains on the seam for a strategy
that needs configuration `base_url` cannot express; bunq turned out not to be one.

**`verify` earns its place.** It was declared for bunq's response signatures and is used for two
things: checking them, and noticing a 401. The second is what lets a session that expired early
recover without anybody intervening, because nothing else on the seam sees a response.

**A strategy provider skips the credential resolver entirely.** `dispatch` branches before
`authorizeRequest`, because a strategy has no static `ResolvedCredential` to produce. `resolve.ts`
keeps refusing strategies, which is correct for the non-HTTP transports that take a resolved
credential directly and could not use one.
