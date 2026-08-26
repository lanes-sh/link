# OAuth 2.0 JWT bearer (RFC 7523)

A key the operator holds, signed into a short-lived assertion and exchanged for
an access token. No browser, and **no refresh token** — there is nothing to
refresh, because a new assertion is signed whenever the last token ages out.
That is the point: an authorization-code refresh token lives or dies by the
issuer's policy, and a key does not.

Not a `kind` of its own. It is declared as `auth.assertion` on an existing
`oauth` block, because it is a second arrangement for the same provider rather
than a different provider — so `credentialRefForConnection`, `setupRequirements`
and the deploy grants all stay as they were. Which arrangement a connection uses
is decided by the *shape* of what is stored at `<provider>/<connection>`:
`isStoredAssertion` is that test, and `resolve.ts` asks it before building an
authorization-code provider.

| File | What it owns |
|---|---|
| `key.ts` | the key file's layout, PEM to DER, and the signed claim set — no I/O |
| `index.ts` | reading the pointer, the exchange, the process-lifetime token cache |

The endpoint comes from `token_uri` **inside the key file**, never from a
constant here, which is what keeps this folder free of any vendor. A second
vendor offering the same grant is a manifest and no code.

## What it cannot do

An assertion authenticates the key, and a key is not a person. It reaches only
what has been shared with its address — unless the identity provider is
configured to let it act as someone, which is an administrator's grant and not
the operator's. `auth.assertion.delegation` says which of the two a provider is,
and `cli/commands/connect/method.ts` is where that becomes a sentence someone
reads before choosing.
