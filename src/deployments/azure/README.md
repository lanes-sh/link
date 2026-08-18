# Azure — not implemented

There is no Azure target. This folder exists to say what one would need, because
the answer is short and the alternative is someone reading `target.ts` to work it
out.

Three backends, and two of them already exist:

| Interface | What Azure offers | Adapter |
|---|---|---|
| `Database` | Azure Database for PostgreSQL | `adapters/postgres.ts` — **reuse it** |
| `BlobStore` | Azure Blob Storage | `adapters/s3.ts` if the account has the S3-compatible endpoint enabled, otherwise a new `adapters/azure-blob.ts` |
| `SecretStore` | Key Vault | new: `adapters/azure-key-vault.ts` |

So the real work is one adapter, plus a `target.ts` here composing the three and
a deploy driver for Container Apps. Follow `../gcp/` — its `deploy.ts` builds an
argv array and never a shell string, and its `--dry-run` prints exactly what
would run.

The one thing not to copy from `../gcp/` is the assumption that `gcloud` is on
the PATH. That is a property of that deployment, not of deployments generally.
