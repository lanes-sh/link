# ADR-022: the vault rides the secret store, not the bucket

**Status:** accepted · **Supersedes** [ADR-014](014-owner-layer-is-managed.md)'s placement of the
vault document in blob storage. The rest of ADR-014 — that all three owner stores follow the
target rather than defaulting to a container filesystem — stands, and this is that rule applied
with a better answer for one of them.

## Decision

`vaultTargetSchema` gains a third adapter: `file` | `blob` | **`secret`**. The whole vault
document — one AES-256-GCM blob, magic `lanes-link-vault` — becomes a single entry in the target's
own `SecretStore`, at ref `vault/document`. Deployed, that is Google Secret Manager.

## This is not the merge `#secrets` forbids

`src/secrets/index.ts` opens by saying the two stores must never become one, and it is specific
about what that means: **no shared key, no shared document, no shared environment variable**. All
three still hold. `LANES_LINK_VAULT_KEY` seals the document before the secret store ever sees it,
so what lands there is ciphertext the credential store cannot read — asserted directly in
`vault-secret.test.ts`, including that the item *names* are inside the sealed document too.

The backend was never on that list. The two stores have shared `document.ts` and shared adapters
since they were merged; what was kept apart was the key, and it still is. The two reachability
tests — `dispatch/control-plane.test.ts` and `providers/vault/provider.test.ts` — are about code
paths and are untouched.

## Why the bucket arrangement was backwards

`blob` put the vault in object storage so that reading it took two things: bucket access *and* the
vault key. That reads like defence in depth and is not, because of where the key already lives.
`LANES_LINK_VAULT_KEY` arrives on a deployment through `--set-secrets`, from Secret Manager. So
the second factor was already in the system the first factor was protecting against.

And the asymmetry ran the wrong way. Anyone with Secret Manager read access already holds every
OAuth refresh token — the whole of Gmail, Drive, and iCloud, with no further step. The vault is
the *smaller* asset, and it was the one behind the taller fence.

## Consequences

- **A default deployment needs no bucket for the vault.** Combined with
  [ADR-020](020-the-log-is-objects.md) and [ADR-021](021-no-database.md), the deployed target's
  standing dependencies are Secret Manager and one bucket — and the bucket is for state, the log,
  memory, skills and attachments, not for this.
- **A deployed instance now writes to Secret Manager**, which `gcp-secret-manager.ts` says it
  never does. That statement has to become narrower rather than false: it may add a version to the
  **vault document and nothing else**. `lanes link deploy` grants
  `roles/secretmanager.secretVersionAdder` conditioned on that one resource, on top of the
  project-wide accessor role. Granting the write half unconditionally would undo the reason the
  split existed.

  [ADR-026] corrects the "and nothing else": an OAuth refresh persists, so a revision had been
  rewriting connection tokens the whole time this said it wrote one secret. The grant it describes
  is now one binding per rotated secret, on the same reasoning — what the split protects is that a
  running instance cannot *create* a credential reference, not that it never writes.

  That ADR also records why this arrangement had never actually worked: the adapter called
  `secrets.create` before adding a version, so the narrow grant this specifies was refused on every
  `vault put` a deployment ever made.
- **A `vault put` costs a secret version.** Nothing prunes them: a prune needs
  `secretmanager.versions.destroy`, which is deliberately not granted to the identity a deployment
  runs as. At a few cents per version-month and `vault put` being a rare human action, that is the
  cheaper end of the trade.
- **64 KiB is the ceiling**, guarded with a message that says so. A vault holds keys and
  passwords; anything approaching that limit is a file in the wrong place.
- `blob` stays, for anyone who wants the old arrangement or is not on a versioned secret store.

[ADR-026]: ./026-a-revision-rotates-its-own-credentials.md
