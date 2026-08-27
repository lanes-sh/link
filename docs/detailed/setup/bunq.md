# Connecting bunq

Bank accounts, balances, transaction history, and payments.

```
lanes link connect bunq
```

You are asked for one API key, generated inside the bunq app. There is no web
console, no OAuth client, and no browser consent — bunq does not offer one for
your own account.

**Read the next section before you connect this one.** It is the only provider
here that can move money.

## What an agent can do with this

Eleven operations, and three of them spend:

| | |
|---|---|
| `bunq.List_all_User` | The user id every other call is addressed under |
| `bunq.List_all_MonetaryAccount_for_User` | Accounts and balances |
| `bunq.List_all_Payment_for_User_MonetaryAccount` | Transaction history |
| `bunq.READ_Payment_for_User_MonetaryAccount` | One transaction |
| `bunq.List_all_DraftPayment_for_User_MonetaryAccount` | Drafts awaiting approval |
| `bunq.READ_DraftPayment_for_User_MonetaryAccount` | One draft |
| `bunq.List_all_PaymentBatch_for_User_MonetaryAccount` | Batches |
| **`bunq.CREATE_Payment_for_User_MonetaryAccount`** | **Pays. Immediately, and irreversibly.** |
| **`bunq.CREATE_PaymentBatch_for_User_MonetaryAccount`** | **Pays up to 350 recipients at once** |
| `bunq.CREATE_DraftPayment_for_User_MonetaryAccount` | Prepares a payment for you to approve in the app |
| `bunq.UPDATE_DraftPayment_for_User_MonetaryAccount` | Accepts or rejects a draft |

A direct payment has no confirmation step anywhere — not in the app, not by
email, not here. bunq accepts the call and the money is gone. A *draft* payment
is the same call with a human in the middle: it appears in the bunq app and does
nothing until you approve it.

### Three bounds, and only one of them is ours

**A spending limit on the API key**, set in the bunq app. This is the one that
does not depend on any software here being correct — not the policy engine, not
the tool list, not this document. Set it, and set it low.

**Policy.** `connect` writes allow lines for what it discovered, and for an HTTP
provider every `POST` lands in the `write` bundle — so connecting with write
grants the payment tool. To keep an agent to drafts only:

```
lanes link policy deny 'bunq.CREATE_Payment_for_User_MonetaryAccount'
lanes link policy deny 'bunq.CREATE_PaymentBatch_for_User_MonetaryAccount'
lanes link policy deny 'bunq.UPDATE_DraftPayment_for_User_MonetaryAccount'
```

**All three.** The first two are the obvious ones. The third is the one that
makes the other two mean anything: `UPDATE_DraftPayment` with
`status: ACCEPTED` *is* how a draft becomes a payment, so an agent left holding
it can create a draft and approve its own draft, and the human checkpoint the
first two lines were bought for does not exist. Denying it costs you nothing an
agent should have — accepting, rejecting and cancelling a draft are all things
to do in the bunq app, which is the entire point of a draft.

That leaves reading and draft-*making* intact, and every payment then waits for
you in the app.

**The vendored spec.** Nothing outside the eleven operations above exists as a
tool, so no rule can allow it. Standing orders, opening and closing accounts,
and ordering cards are all reachable in bunq's API and deliberately absent here.

## Try it against the sandbox first

bunq runs a public sandbox that needs no bank account. Everything below works
against it, and nothing that happens there is real.

Copy the vendored spec next to a manifest of your own, in
`<workspace>/data/<profile>/providers.d/`. A relative `openapi:` resolves
against the manifest's own directory, so keeping the two together is what makes
the path work wherever the workspace is:

```console
$ cd <workspace>/data/<profile>/providers.d
$ cp "$(dirname "$(readlink -f "$(which lanes)")")"/../src/providers/bunq/specs/bunq.v1.json .
```

```yaml
id: bunq_sandbox
name: bunq (sandbox)
connector:
  kind: http
  base_url: https://public-api.sandbox.bunq.com/v1
  openapi: ./bunq.v1.json
auth:
  kind: strategy
  strategy: bunq
```

There is no sandbox flag. The strategy reads its host from `base_url`, so this
manifest handshakes and pays against the sandbox and the built-in `bunq` does
neither. That is deliberate: a flag beside `base_url` is a second thing to keep
true, and getting it wrong would open a session against the sandbox and spend it
against production — which authenticates cleanly and then answers about an
account that does not exist.

`strategy: bunq` names code the built-in provider carries; borrowing it is not
borrowing the credential, since this manifest's own id derives
`bunq_sandbox/<connection>`.

A sandbox key comes from bunq's tinker flow; see
[doc.bunq.com](https://doc.bunq.com/).

## The API key

1. In the bunq app: **Profile → Security & Settings → Developers → API keys →
   Add API key**.
2. Name it `Lanes Link`, so you can revoke this one later without touching your
   others.
3. **Set a spending limit on the key.** See above.
4. **If this endpoint will ever run anywhere but this machine**, mark the key as
   a *wildcard* key in the same screen. bunq binds a key to the addresses it has
   been used from, and Cloud Run's egress address is not stable. The wildcard
   setting cannot be enabled over the API — deliberately, so it cannot be turned
   on by something that is not a person — so this step is yours and nothing can
   do it for you.
5. Copy the key and run `lanes link connect bunq`.

You are then asked what to call the connection. bunq publishes no endpoint that
reports whose account a key belongs to, so unlike Gmail or GitHub the label is
yours to choose rather than something we can read.

## What connect actually does

More than store a value, which is why this provider needs code where every other
one needs a manifest. On `connect`:

1. A 2048-bit RSA keypair is generated on this machine. The private half never
   leaves it.
2. `POST /installation` hands bunq the public half and gets back an installation
   token and bunq's own public key.
3. `POST /device-server` registers the key against your account, using the API
   key you pasted. **This is the step that rejects a wrong key**, so a bad
   paste fails here — with bunq's message — before anything is written to your
   config.
4. The API key, the private key, the installation token and bunq's public key
   are stored together under one reference, `bunq/<connection>`.

No session is opened yet. The first real call opens one and keeps it in state
for six days; see [ADR-046](../adr/046-an-auth-strategy-belongs-to-its-provider.md)
for why it lives there rather than beside the credentials.

Every request after that is signed: bunq requires an RSA signature over the
request **body** in `X-Bunq-Client-Signature`, and replies with a signature of
its own that this checks.

## When it stops working

**`bunq refused the session`, or a 401 on one call and success on the next.**
Working as intended. A bunq session lasts as long as your account's auto-logout
setting — a week by default — and if yours is shorter, the first call after it
elapses fails and drops the session. The call after that opens a new one.

**Every call is refused after a deploy or an ISP change.** The key is bound to
addresses it has been used from. Mark it as a wildcard key in the app.

**`answered 429`.** bunq rate-limits, and `/session-server` hardest: one call
per thirty seconds. Ordinary calls are 3 GETs and 5 POSTs per three seconds.

**Anything else.** Generate a new key in the app and run
`lanes link connect bunq --replace`.

## Refreshing the vendored spec

```
bun run vendor:bunq
```

bunq's published document cannot be used as it stands: generating tools from it
fails on 55 operations, every payment endpoint among them, because `Payment`
recurses through `RequestInquiry` and `RequestResponse`. The script cuts those
cycles, drops the protocol headers bunq declares on every operation — including
`X-Bunq-Client-Authentication`, which must never be an argument a model can
fill in — and strips the response-only fields bunq's request bodies inherit from
pointing at whole resources. The result is committed, so what an operator's
credential can be pointed at is reviewable in a diff.
