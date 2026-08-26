# ADR-028: A hosted OAuth client is the default, and registering your own is one flag away

**Status:** accepted · **Amends** [ADR-005](005-the-cli-performs-the-oauth-exchange.md)

## Context

Connecting Gmail cost an operator nine console steps: create a Cloud project, enable two APIs,
fill in a branding screen, set an audience, transcribe four scope URLs, create a Desktop client,
and copy two values out. Then it cost them a weekly interruption forever, because nobody publishes
a personal project and **Google expires refresh tokens after seven days for any project whose
publishing status is "Testing"**. `doctor` grew a warning for it. `setup/google.md` grew a
paragraph explaining that the alternative was a verification review with a CASA assessment taking
months.

That is not a policy anyone chose. It is what happens when the only two options are "the operator
registers a client" and "the client secret ships in the binary" — and the second is not an option,
because an installed application cannot hold a confidential client.

There is a third: somebody runs one, and performs the exchange.

## Decision

A provider manifest may declare `auth.broker`, naming a service that holds an OAuth client secret
and exposes `/config`, `/exchange`, and `/refresh`. Every Google REST provider declares the client
Lanes operates. Where one is declared and the profile has not registered a client of its own, that
is what `connect` authorises against.

**The manifest does not choose between the two — the profile does.** Declaring an `oauth_apps`
entry means "I registered a client, use it"; leaving it out means "use the one the broker
operates". `registration: manual` stays true either way, because the vendor does still require a
pre-registered client. That is why this is a second field rather than a third `registration`
value: a manifest that claimed one arrangement would be wrong half the time.

`lanes link connect <provider> --own-client` takes the other path. It writes the `oauth_apps`
entry, so the choice is made once and then sticks.

Two scopes are added on the brokered path only: `openid` and `email`. The exchange returns an
identity assertion, which is presented on every later refresh so the broker can tell one caller
from another. On the bring-your-own path there is nobody to identify to, so the scope set is
byte-identical to what it was.

## What this does not change

ADR-005's argument survives intact, and the parts that survive are worth naming because "the
endpoint calls a Lanes API" sounds like it might have moved them:

- The **CLI** still runs the flow. The server still never participates.
- The redirect is still a **loopback listener** this process opened on a port the OS picked.
- The browser still talks to the **vendor** directly. Consent is between the operator and Google.
- The credential still lands in **whichever store the config names**, so a deployed instance is
  unaffected and needs no inbound path.
- The client is still registered as a **Desktop app**, for the same reason: loopback.

What moves is step 2 of ADR-005's list — *who holds the client secret* — and therefore step 4,
*where the code becomes a token*.

It is **not** ADR-025. No consent moves to a server, there is no `/callback` route, no
pending-authorization state, no IAM widening, and an agent still cannot connect an account.
`connect` remains CLI-only and `control-plane.test.ts` is untouched, so ADR-007 is untouched.

It is compatible with **ADR-026** unchanged: a brokered connection still rewrites exactly one
secret while serving, its own token blob.

## Consequences

**The exchange stops being local, and the guarantee table says so.** The authorization code goes
to the Lanes API, the refresh token comes back through it, and passes through it again on every
refresh. Nothing in this repository can verify what that API does with what it sees. This is
recorded as `credentials.exchange-is-local: NOT-GUARANTEED` in
[`security.md`](../security.md), with the alternative named in the same paragraph.

**The hosted client is capped, and the cap is permanent.** Google limits an app with unapproved
sensitive or restricted scopes to 100 accounts, counted over the entire lifetime of the project,
with no way to reset it. Until verification completes that is the ceiling. `/config` reports
consumption so the CLI can warn before it is reached, and reports a `status` the broker controls so
the tap can be closed with wording chosen at the time rather than shipped in a release.

**Users see an unverified-app interstitial** until verification completes. The client is
nevertheless published "In production" rather than left in "Testing", because that is precisely
what removes the seven-day expiry — which was the larger of the two costs this ADR set out to
remove, and the one an operator cannot work around.

**A shared client is a shared dependency.** An outage in it stops `refresh`, not merely `connect`,
which means it can fail in the middle of an agent's work rather than only at setup. The refusal
names a command the owner runs, and `--own-client` is the exit.

**A brokered token cannot be migrated to an own client.** Which client minted a refresh token is
stamped on the token itself (`authorized_via`), not read from config, because a refresh token
minted by one client is refused by another. So adding an `oauth_apps` entry later does not move
existing connections onto it — they keep refreshing where they were issued, and only a fresh
`connect` moves them. The alternative, reading the current config, would turn an unrelated-looking
config edit into `invalid_grant` on every connection at once.

**An MCP provider cannot be brokered.** ~~The SDK owns that exchange and there is no seam to route
it without reimplementing its auth path.~~ **Struck by
[ADR-040](040-an-mcp-connector-may-use-a-pre-registered-client.md):** the seam is a manifest naming
its own `authorize_url` and `token_url`, which takes the provider off the SDK's flow and onto the
direct one entirely. `defineProvider` now refuses only the half-declared case, where the SDK would
run the flow and then redeem the code with a client it does not hold.
