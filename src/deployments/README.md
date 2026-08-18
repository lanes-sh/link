# Deployments

Where a profile runs. A target names one, and the whole of the difference is
two backends: a `SecretStore` and a `BlobStore`. Connections, providers, policy
and limits are declared once and apply to every target.

| Folder | Target | Secrets | Blobs | Vault |
|---|---|---|---|---|
| `local/` | `local` | encrypted file | `filesystem` | `file` |
| `gcp/` | `cloud` | `gcp-secret-manager` | `gcs` (or `s3`) | `secret` |
| `azure/` | — | not implemented | | |

There is no database column, and no database. State is one object per key and
the audit log is one object per event, both in whatever `BlobStore` the target
already opened — so the deployed target has exactly two standing dependencies
and neither of them is a service to provision (ADR-020, ADR-021).

## Adapters are named for the protocol, deployments for the vendor

`s3` needs an endpoint and a key pair; `gcs` needs neither, because it
authenticates as the identity already present. R2, MinIO, Supabase Storage and
AWS differ only in those values, so a vendor name on the adapter would claim a
coupling that does not exist and would have to be either lied about or
duplicated the first time someone pointed it elsewhere (ADR-013). The host is a
deploy-time choice; the protocol is the interface.

That is why `adapters/` is flat and shared, and why the GCP folder holds no
storage code — only the things that genuinely are Google's: how to roll a Cloud
Run revision, what to create before the first one, and what to ask when the
config does not say yet.

## Adding one

1. A folder here.
2. If it needs a backend nobody has written, an adapter in `adapters/` named for
   the protocol.
3. A case in `target.ts`, importing that adapter **inside the branch** — a local
   run must not load a cloud client, or a missing cloud credential fails a
   `lanes link start` that was never going to talk to that cloud.
4. A member of the adapter enums in `#profile`'s schema, so a target can name it.
5. To be deployable: a `DeployDriver` (`driver.ts`) and a case in `drivers.ts`,
   imported inside the branch for the same reason. Add its name to the
   `deploy.platform` enum in `#profile`'s schema.

Nothing else in the codebase learns about it. In particular the CLI does not:
`lanes link deploy` is a thin wrapper that dispatches to the deployment's own
driver through `drivers.ts`, and the machinery for rolling a revision lives with
the vendor that needs it. A driver returns its steps as **data** — argv arrays,
never shell strings — which is what makes `--dry-run` show the real sequence and
what lets the commands be asserted in a test with no cloud account anywhere near
it.

What is *not* the driver's: the deployment block is named `deploy` and carries a
`platform`, so which vendor a target uses is a value rather than the name of a
key. `project` is optional in that block and required by the driver that needs
one, on the same reasoning as `credentials.project`.

## Blob storage is not optional in a deployment

`adapter: filesystem` on Cloud Run **appears to work**: every write succeeds,
every read within the life of an instance succeeds, and the bytes are gone when
the instance recycles. A missing adapter that throws is a smaller problem than a
present adapter that silently loses data. See ADR-013.
