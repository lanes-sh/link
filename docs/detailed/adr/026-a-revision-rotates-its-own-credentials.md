# ADR-026: a revision rotates the credentials it reads with

**Status:** accepted · **Narrows** [ADR-022](022-the-vault-rides-secret-manager.md)'s consequence
that a deployed instance may write "the vault document and nothing else". The reasoning ADR-022
gives for the split stands and is what this is measured against; the list of exceptions was one
short, and had been since before the vault was on it.

## Decision

A deployed revision is granted `roles/secretmanager.secretVersionAdder` on **each secret it
rewrites while serving** — the vault document, and every connection's OAuth token. `deploy` creates
each container and binds each one individually. `secrets.create` stays with the operator.

## What was actually broken

`gcp-secret-manager.ts` said a deployed instance never writes its own credentials, and
`deployment-cloudrun.md` said write access stays with the operator's account. Neither was true, and
neither had been since OAuth worked at all: `refreshDirectly` exchanges a stored refresh token and
persists the result, so **an ordinary read is a write**. Gmail access tokens last an hour. Every
deployed endpoint therefore worked for an hour and then failed every request until it was
redeployed, at which point it worked for another hour.

Two things kept that invisible for as long as it lasted.

The first is that the failure surfaced as `PERMISSION_DENIED: secretmanager.secrets.create`, which
reads as "this secret does not exist yet" and is not. `set` created the container before adding a
version, unconditionally, and Secret Manager checks IAM before existence — so an identity holding
`secretVersionAdder` on a secret that is right there gets 403 rather than `ALREADY_EXISTS`. The
message named a permission nobody needed and pointed at provisioning rather than at the grant.

The second is that the same 403 was reachable through `vault.put`, which ADR-022 had explicitly
grants for. `grants.test.ts` asserted the document's secret is created by `deploy` "so the revision
never needs `secrets.create`" — a true statement about the deploy and a false one about the adapter,
which asked for it anyway. The grant was correct and had never once worked.

## Why this is not the wider grant

The obvious fix is `roles/secretmanager.admin`, and it is the wrong one. What ADR-022 protects is
not "the revision does not write" — it clearly does — but that **a running instance cannot invent a
credential reference**. `secrets.create` is project-level and would hand it exactly that, along with
`versions.destroy`. `secretVersionAdder` on a named secret grants one verb on one resource, and
`deploy` creates the resource so that verb is all a revision ever needs.

That distinction is now the boundary, stated where it is enforced: the split is not read versus
write, it is *rotating what exists* versus *bringing something into existence*.

## Consequences

- **`deploy` emits two steps per rotatable secret**, the pair it already emitted for the vault. The
  first-run list is longer by twice the number of connections. Every step tolerates `ALREADY_EXISTS`,
  so the second deploy onwards is a no-op.
- **The grant list is scoped exactly as the upload is.** A deploy with no `--profile` sends the whole
  workspace, so it binds every profile's connections — binding only the resolved one would leave a
  served profile 403ing an hour later, which is this bug one profile over.
- **A connection authorised after a deploy has no binding.** It also has no config in the bucket, so
  the revision cannot reach it either way, and `connect` already ends by naming `lanes link deploy`.
  The two gaps close together or not at all, which is why there is no second warning.
- **A denied write says which command grants it.** This surfaces to an agent with no cloud context —
  a refused token rotation reaches whoever asked to read their mail — so the adapter supplies the
  half Google cannot: the ref, and `lanes link deploy`.
- **`set` adds a version first and creates only on 404.** One request instead of two in the common
  case, and the race ADR-022's arrangement relied on still cannot break it: two writers both 404,
  both create, the loser gets `ALREADY_EXISTS`, both add.
- **A refresh still costs a secret version, and nothing prunes them.** Same trade as `vault put` and
  a busier one — an hourly rotation per connection, at a few cents per version-month. Pruning needs
  `versions.destroy`, which is deliberately not granted, so this stays the operator's to do.
