import type { AuditReader, AuditSink, AuditStore } from '#audit';
import { ConfigError, layout, workspacePath, type Config, type TargetConfig } from '#profile';
import type { SecretStore } from '#secrets';
import { createFileSecretStore } from '#secrets';
import type { BlobStore } from '#stores/blobs';
import { createRuntimeState, type RuntimeState } from '#stores/state';
import { createBlobAuditStore } from './adapters/audit-blob.ts';

/**
 * Turning a declared target into a set of open adapters.
 *
 * A target names where a profile runs — `local`, `cloud` — and the whole of
 * that difference is the two backends below: where credentials are kept, and
 * where bytes go. State and the audit log ride the second of those rather than
 * declaring backends of their own. Connections, providers, policy
 * and limits are declared once and apply to every target, which is what lets a
 * deployment change nothing at the application layer.
 *
 * **This is the only place the mapping exists.** It used to be three `switch`
 * statements two hundred lines apart inside the CLI's runtime assembly, which
 * meant adding a target meant finding all three and meant the CLI knew what
 * Cloud Run was. Adding one is now a folder beside this file and a case here.
 *
 * Adapters are named for the *protocol* and deployments for the *vendor*
 * (ADR-013). `s3` needs an endpoint and a key pair; R2, MinIO, Supabase Storage
 * and AWS differ only in those values, so a vendor name on the adapter would
 * claim a coupling that does not exist. The host is a deploy-time choice; the
 * protocol is the interface.
 *
 * Cloud adapters are imported *inside* their branch, deliberately: a local run
 * never loads the S3 or Secret Manager client, so a missing GCP credential
 * cannot fail a `lanes link start` that was never going to talk to Google.
 */

export interface TargetInput {
  readonly declared: TargetConfig;
  readonly config: Config;
  readonly root: string;
  readonly target: string;
}

/**
 * Blob storage, rooted per area.
 *
 * Three consumers want it with different roots — the provider blobs a
 * `ProviderContext` is scoped from, the skills directory, and the vault document
 * — and resolving the S3 key pair once rather than three times is why this is a
 * factory rather than a store. On a Secret Manager credential store each of
 * those resolutions is a network call.
 *
 * `area` is a location *within* the target: a workspace-relative directory for
 * the filesystem adapter, a key prefix for S3. Omitting it gives the profile's
 * own blob root, which is what providers get.
 *
 * That last sentence was true of `filesystem` and false of the two bucket
 * adapters, which read an omitted area as the empty prefix — so a deployed
 * instance scattered memory and attachments across the root of the bucket while
 * its state and log sat under `data/<profile>/`. One profile per bucket made it
 * look deliberate. It was not: it put provider blobs outside the prefix the
 * write grant is conditioned on, so the first write 403'd.
 */
export type StorageFactory = (area?: string) => BlobStore;

export async function openSecrets(input: TargetInput): Promise<SecretStore> {
  const { declared, config, root, target } = input;

  switch (declared.credentials.adapter) {
    case 'file':
      return createFileSecretStore({
        path: workspacePath(
          root,
          declared.credentials.path ?? layout.credentials(),
        ),
      });

    case 'gcp-secret-manager': {
      if (!declared.credentials.project) {
        throw new ConfigError(
          `workspaces.${target}.credentials.project is required for the gcp-secret-manager adapter.`,
        );
      }
      const { GcpSecretManagerStore } = await import('./adapters/gcp-secret-manager.ts');
      return new GcpSecretManagerStore({ project: declared.credentials.project });
    }
  }
}

/**
 * Runtime state — connections, provider state, cursors.
 *
 * Not a switch, for the same reason `openAudit` is not one: state is one
 * object per key in whatever `BlobStore` the target already opened. It used to
 * be `sqlite` or `postgres` behind a `database:` block, which was a query
 * engine and a second service bought for a workload that is entirely point
 * reads. See `#stores/state`.
 *
 * Its own root, `layout.state`, so it is not addressable from a provider's
 * blob namespace — the same containment `openAudit` relies on.
 *
 * Two roots, because state divides by what a key is *about*. Connection
 * records, the discovery cache and the endpoint's own OAuth server belong to
 * the workspace: a `connect` run once must read as connected from every
 * profile. Cursors and each provider's own keys belong to the profile, because
 * two agents reading one mailbox at different rates must not consume each
 * other's cursor. `isWorkspaceNamespace` in `#stores/state` is the whole rule,
 * and it is closed — a namespace it does not name is the profile's.
 */
export function openState(storage: StorageFactory, profile: string): RuntimeState {
  return createRuntimeState(storage(layout.state()), storage(layout.profileState(profile)));
}

/**
 * The audit log.
 *
 * Not a switch, because there is only one answer: objects in whatever blob
 * store the target already opened. That is the point of the layout — a
 * directory under the profile locally and a prefix in the bucket deployed are
 * the same tree, so there is one sink rather than one per target and no
 * conformance question about whether the two agree.
 *
 * Named as its own factory rather than folded into `openStorage` because the
 * log is not provider blobs: it gets a root a provider cannot be namespaced
 * into (`layout.audit`), and that separation is what keeps ADR-007's wall
 * intact.
 */
export function openAudit(storage: StorageFactory): AuditStore {
  return createBlobAuditStore({ storage: storage(layout.audit()) });
}

/**
 * The log, plus whatever copies the target asks for.
 *
 * The blob sink is always first and always awaited — `fanOutAudit` treats the
 * first as the record of truth and everything after it as best-effort. That
 * ordering is fixed here rather than declared in config, because "which sink
 * is the log" is not a preference: a sink that can fail cannot carry a
 * guarantee that says every invocation is recorded.
 *
 * Returned as `{ sink, reader }` because the two halves diverge once copies
 * exist: `tail` and `verify` mean the durable log, never the fan-out.
 */
export async function openAuditSinks(
  input: TargetInput,
  storage: StorageFactory,
  secrets: SecretStore,
  log?: (message: string) => void,
): Promise<{ sink: AuditSink; reader: AuditReader }> {
  const durable = openAudit(storage);
  const declared = input.declared.audit?.sinks ?? [];
  if (declared.length === 0) return { sink: durable, reader: durable };

  const secondaries: AuditSink[] = [];
  for (const sink of declared) {
    if (sink.kind === 'stdout') {
      const { createStdoutAuditSink } = await import('#audit/stdout.ts');
      secondaries.push(createStdoutAuditSink());
      continue;
    }

    const headers = sink.headers_ref ? await secrets.get(sink.headers_ref) : null;
    const { createOtlpAuditSink } = await import('./adapters/otlp.ts');
    secondaries.push(
      createOtlpAuditSink({
        endpoint: sink.endpoint,
        ...(headers ? { headers: parseHeaders(headers, sink.headers_ref!) } : {}),
        ...(sink.service_name ? { serviceName: sink.service_name } : {}),
      }),
    );
  }

  const { fanOutAudit } = await import('#audit/fanout.ts');
  return {
    sink: fanOutAudit({
      primary: durable,
      secondaries,
      ...(log ? { onError: log } : {}),
    }),
    reader: durable,
  };
}

/**
 * `key=value,key=value`, the form the OTel SDKs use for `OTEL_EXPORTER_*_HEADERS`.
 *
 * Read from the credential store rather than the config file: these carry an
 * API key, and `profile/secret-detection.ts` would refuse one written inline.
 */
function parseHeaders(raw: string, ref: string): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const pair of raw.split(',')) {
    const at = pair.indexOf('=');
    if (at === -1) {
      throw new ConfigError(
        `The value at "${ref}" is not OTLP headers. Expected key=value pairs separated by commas.`,
      );
    }
    headers[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return headers;
}

export async function openStorage(
  input: TargetInput,
  secrets: SecretStore,
): Promise<StorageFactory> {
  const { declared, config, root, target } = input;

  switch (declared.storage.adapter) {
    case 'filesystem': {
      const { createFilesystemBlobStore } = await import('./adapters/filesystem.ts');
      const base = declared.storage.path ?? layout.blobs(config.instance.profile);
      return (area) =>
        createFilesystemBlobStore({ root: workspacePath(root, area === undefined ? base : area) });
    }

    case 'gcs': {
      // No key pair: this authenticates as whatever identity is already
      // present — the Cloud Run service account the deploy granted
      // objectAdmin, or the operator's own gcloud credentials locally. That is
      // the whole reason it exists beside `s3`, which needs HMAC keys minted
      // by hand in a console.
      const { bucket, prefix } = declared.storage;
      if (!bucket) {
        throw new ConfigError(`workspaces.${target}.storage.bucket is required for the gcs adapter.`);
      }

      const { createGcsBlobStore } = await import('./adapters/gcs.ts');
      const base = prefix ?? '';
      const root = layout.blobs(config.instance.profile);

      return (area) =>
        createGcsBlobStore({
          bucket,
          prefix: `${base}${area ?? root}/`,
        });
    }

    case 's3': {
      const { bucket, endpoint, region, prefix } = declared.storage;
      if (!bucket) {
        throw new ConfigError(`workspaces.${target}.storage.bucket is required for the s3 adapter.`);
      }

      const accessKeyId = await requireSecret(
        secrets,
        declared.storage.access_key_id_ref,
        `workspaces.${target}.storage.access_key_id_ref`,
        target,
      );
      const secretAccessKey = await requireSecret(
        secrets,
        declared.storage.secret_access_key_ref,
        `workspaces.${target}.storage.secret_access_key_ref`,
        target,
      );

      const { createS3BlobStore } = await import('./adapters/s3.ts');
      const base = prefix ?? '';
      const root = layout.blobs(config.instance.profile);

      return (area) =>
        createS3BlobStore({
          bucket,
          accessKeyId,
          secretAccessKey,
          ...(endpoint !== undefined ? { endpoint } : {}),
          ...(region !== undefined ? { region } : {}),
          prefix: `${base}${area ?? root}/`,
        });
    }
  }
}

/**
 * Resolve a declared secret ref, or say which one is missing and how to store
 * it.
 *
 * Two refs make the same two mistakes available twice over, and "undefined is
 * not a string" from inside an S3 client is not a diagnosis.
 */
export async function requireSecret(
  secrets: SecretStore,
  ref: string | undefined,
  field: string,
  target: string,
  requiredBy = 'the s3 adapter',
): Promise<string> {
  if (!ref) {
    throw new ConfigError(
      `${field} is required for ${requiredBy} — the value is a credential, so config names it ` +
        'rather than carrying it.',
    );
  }

  const value = await secrets.get(ref);
  if (!value) {
    throw new ConfigError(
      `${field} names "${ref}", which is not in this target's secret store. ` +
        `Store it with: lanes link secrets set ${ref} --workspace ${target}`,
    );
  }
  return value;
}
