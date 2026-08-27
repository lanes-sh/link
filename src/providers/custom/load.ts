import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defineProvider, type ProviderManifest } from '#connectivity';
import { ConfigError, isRemoteWorkspace, layout, readWorkspaceFile, workspaceFiles } from '#profile';
import { findSecrets, formatSecretFindings } from '#profile';
import type { BlobStore } from '#stores/blobs';

/**
 * Provider manifests supplied by the operator.
 *
 * The built-in list is a convenience, never a boundary. Anything not shipped is
 * a YAML file in `<workspace>/data/<profile>/providers.d/`, validated by the
 * same schema the built-ins are — no code, no rebuild, no pull request.
 *
 * That is the whole scalability claim of this milestone: a service nobody has
 * integrated costs a file.
 *
 * **Per profile**, which the workspace-wide directory this replaced was not. A
 * manifest names a host, an OpenAPI document, and the credential refs that
 * reach them, so it describes somebody's infrastructure — and work's is not
 * personal's to read. The path comes from `layout` for the same reason every
 * other profile-owned path does: one place that knows the on-disk shape.
 * ADR-030.
 *
 * **Read through the workspace's store, not through `node:fs`.** A deployed
 * revision is handed `LANES_LINK_HOME=gs://<bucket>`, and `join` collapses that
 * to `gs:/bucket/…` — so a `readdir` threw ENOENT and the catch below reported
 * the same empty list it reports for a workspace that simply has no manifests.
 * The manifest was uploaded, the read grant covered it, and nothing looked at
 * it: a custom provider worked locally and silently did not exist once
 * deployed. Skills were already read through a `BlobStore` for exactly this
 * reason; manifests now are too. ADR-046.
 */

export interface LoadedManifest {
  readonly manifest: ProviderManifest;
  /** Where this came from, for a refusal to name. A path, or a bucket URL. */
  readonly path: string;
}

export async function loadProfileProviders(
  workspaceRoot: string,
  profile: string,
  /** Injected for tests. A bucket is the case this exists to cover. */
  store?: BlobStore,
): Promise<LoadedManifest[]> {
  const files = store ?? workspaceFiles(workspaceRoot);
  const directory = layout.providers(profile);

  let keys: string[];
  try {
    keys = (await files.list(`${directory}/`)).map((entry) => entry.key);
  } catch {
    return []; // No custom providers is the normal case.
  }

  const loaded: LoadedManifest[] = [];

  for (const key of keys.sort()) {
    const name = key.slice(directory.length + 1);

    // A manifest is a file in this directory, not below it. An OpenAPI document
    // a manifest points at may well sit in a subdirectory, and it is not one.
    if (name.length === 0 || name.includes('/')) continue;
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
    if (name.endsWith('.example.yaml')) continue;

    const text = await readWorkspaceFile(files, key);
    if (text === null) continue; // Listed, then gone. Not worth failing over.

    const where = describe(workspaceRoot, key);
    loaded.push({
      manifest: resolveSpecPath(parseManifest(text, where), workspaceRoot, key),
      path: where,
    });
  }

  return loaded;
}

/** Where a manifest came from, in the spelling this workspace uses. */
function describe(workspaceRoot: string, key: string): string {
  return isRemoteWorkspace(workspaceRoot) ? `${workspaceRoot}/${key}` : join(workspaceRoot, key);
}

/**
 * Make a relative `openapi` path mean what the operator meant.
 *
 * `docs/detailed/creating-a-provider.md` tells people to write `openapi: ./mything.json`,
 * and until now that resolved against the *process* working directory — so it
 * worked when you happened to run `lanes` from the right folder and failed
 * with a confusing ENOENT everywhere else. The built-ins never noticed because
 * they compute an absolute path from `import.meta.url`.
 *
 * Resolved against the manifest's own directory, the way one file referencing
 * another normally works.
 *
 * A bucket-hosted workspace has no such directory to resolve against: the
 * generator wants a filesystem path or a URL, and `gs://…/spec.json` is
 * neither. Refused here rather than at the first call, where it arrives as a
 * discovery failure the runtime swallows — leaving a provider with no
 * capabilities and nothing saying why.
 */
function resolveSpecPath(
  manifest: ProviderManifest,
  workspaceRoot: string,
  key: string,
): ProviderManifest {
  const connector = manifest.connector;
  if (connector.kind !== 'http') return manifest;
  if (/^https?:/i.test(connector.openapi) || isAbsolute(connector.openapi)) return manifest;

  if (isRemoteWorkspace(workspaceRoot)) {
    throw new ConfigError(
      `${describe(workspaceRoot, key)}: openapi "${connector.openapi}" is a relative path, ` +
        `but this workspace is ${workspaceRoot}. A document in a bucket cannot be opened as a ` +
        'file — publish the spec at a URL and name that instead.',
    );
  }

  const directory = dirname(join(workspaceRoot, key));
  return {
    ...manifest,
    connector: { ...connector, openapi: resolve(directory, connector.openapi) },
  };
}

export function parseManifest(text: string, source = '<manifest>'): ProviderManifest {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`${source}: could not parse YAML — ${(error as Error).message}`);
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${source}: expected a YAML mapping at the top level`);
  }

  // A manifest is config, so it is held to the same rule config is: references
  // into the credential store, never values. Someone writing their first
  // manifest will reach for pasting the API key directly, and this is what
  // stops that becoming a credential in a file they might commit.
  const secrets = findSecrets(raw);
  if (secrets.length > 0) {
    throw new ConfigError(
      `${source}: ${formatSecretFindings(secrets)}`,
      secrets.map((finding) => finding.path),
    );
  }

  try {
    return defineProvider(raw);
  } catch (error) {
    throw new ConfigError(`${source}: ${(error as Error).message}`);
  }
}
