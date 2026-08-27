# Credential types

One folder per method. Each owns both halves of its job: `resolve*` turns the
stored secret into a `ResolvedCredential`, and `attach*` puts that shape on an
outbound request. `resolve.ts` and `authorize.ts` are the only files that know
the whole set — plus `token.ts`, which answers the narrower question a
transport asks when it has a token to send and no request to attach it to.

| Folder | `auth.kind` | What is stored |
|---|---|---|
| `none/` | `none` | nothing — `fs` and `local` providers hold no account |
| `bearer/` | `bearer` | a token, sent as `Authorization: Bearer <token>` |
| `header/` | `header` | a value, sent raw in a named header (shares api-key's attach) |
| `api-key/` | `api_key` | a key, in a header or the query string |
| `basic/` | `basic` | `username:password`, RFC 7617's own encoding |
| `oauth-authcode/` | `oauth` | a refresh token, exchanged on every use |
| `oauth-jwt/` | `oauth` + `assertion` | a private key, signed into an assertion per exchange |
| `strategy/` | `strategy` | the escape hatch — the seam only; the code is the provider's |

## Adding one

A folder, a member of `authSchema` in `../manifest/auth.ts`, and a case in
`resolve.ts` (plus `authorize.ts` if it touches the request). Nothing else in
the codebase learns about it — that is the point of the split.

`strategy/` is the other shape, and holds no vendor code at all. It resolves the
strategy a manifest names from the `ProviderDefinition` beside it and refuses
when the two disagree; the implementation lives with its provider, because a
folder of vendor code under `connectivity/` is precisely what the vendor-name
rule in `architecture.test.ts` exists to prevent. `providers/bunq/strategy/` is
the one there is. See [ADR-046](../../../docs/detailed/adr/046-an-auth-strategy-belongs-to-its-provider.md).

`oauth-jwt/` is the exception that proves the shape rather than breaking it. It
is not a `kind`, because it is a second way into a provider that already has
one, so it hangs off the OAuth block as `auth.assertion` and is selected by the
shape of the stored credential. Everything else about it is an ordinary folder
here.

These are named in the credential-type list this design is measured against and
are **not built**:

- `sigv4/` — AWS SigV4 request signing
- `gcp-token/` — service account → GCP access token
- `gcp-iap/` — service account → an IAP-signed JWT
- `oauth-client-creds/` — OAuth 2.0 client credentials
- `body-param/` — the credential as a request body parameter

Each is a folder here plus a schema member. None of them is a change to a
transport, a provider, or the dispatch path, which is the property this layout
exists to give.
