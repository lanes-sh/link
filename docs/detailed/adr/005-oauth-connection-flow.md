# ADR-005: The CLI performs the OAuth exchange, over a loopback redirect

**Status:** accepted · **Milestone:** M1 (mechanism) / Stage 2 (Gmail)

## Decision

`lanes link connect <provider>` runs the OAuth exchange from the **CLI**, using a temporary local listener on
`http://127.0.0.1:<port>/callback`. **The server never participates in the OAuth dance.**

1. Resolve the target config and verify the provider is declared there.
2. Read the provider's `oauth_app` entry and resolve the client id and secret from the configured
   credential store — prompting for them on first use, per the provider's own `setup` declaration.
3. Start the loopback listener and open the browser to the vendor's consent screen.
4. On the callback, exchange the code for a refresh token, read the account's identity from the
   token, write the refresh token to the credential store, and shut the listener down.

## Why the CLI and not the server

It works identically whether the instance is local or on Cloud Run, because the CLI writes to
whichever credential store the config names. It requires no public HTTPS callback, no domain
verification, and **no inbound path to the server** — which is what keeps the deployed instance free
of any administrative surface (ADR-007).

## Consequences

**Register the OAuth client as a "Desktop app"**, which is the type that permits loopback redirect
URIs.

**Identity comes back from the token.** That is what lets a connection be named after the account
(`gmail.ada_lovelace`) instead of asking the operator to invent an id.

**`connect` refuses an undeclared connection**, so a typo cannot orphan a secret. Config declares;
`connect` authorises.

**Widening scope requires re-consent.** This is the asymmetry that shapes the command surface:

```
lanes link policy deny gmail.send gmail.main    # tightening: local, instant, no browser
lanes link connect gmail.main --add write       # widening: browser re-consent, unavoidable
```

Providers declare **bundles** mapping one name onto both layers — `gmail.read` is both a set of
vendor scopes and a set of capabilities — so an operator names the thing they mean once.

## Verify before implementing

A Google Cloud project left in **"Testing"** publishing status expires refresh tokens after roughly a
week, which would silently kill every Gmail connection on a schedule. Move the app to production.
Gmail read scopes are restricted, so an unverified production app shows a warning screen and is
subject to a user cap; for single-owner use, accept it. A Workspace domain with an "Internal" app
avoids this entirely. **Confirm current Google policy at implementation time — these rules change.**
