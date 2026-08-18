import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defineProvider, type ProviderManifest } from '#connectivity';
import { ConfigError } from '#profile';
import { findSecrets, formatSecretFindings } from '#profile';

/**
 * Provider manifests supplied by the operator.
 *
 * The built-in list is a convenience, never a boundary. Anything not shipped is
 * a YAML file in `<workspace>/providers/`, validated by the same schema the
 * built-ins are — no code, no rebuild, no pull request.
 *
 * That is the whole scalability claim of this milestone: a service nobody has
 * integrated costs a file.
 */

export const WORKSPACE_PROVIDER_DIR = 'providers';

export interface LoadedManifest {
  readonly manifest: ProviderManifest;
  readonly path: string;
}

export async function loadWorkspaceProviders(workspaceRoot: string): Promise<LoadedManifest[]> {
  const directory = join(workspaceRoot, WORKSPACE_PROVIDER_DIR);

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return []; // No custom providers is the normal case.
  }

  const loaded: LoadedManifest[] = [];

  for (const name of entries.sort()) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
    if (name.endsWith('.example.yaml')) continue;

    const path = join(directory, name);
    loaded.push({ manifest: await parseManifestFile(path), path });
  }

  return loaded;
}

export async function parseManifestFile(path: string): Promise<ProviderManifest> {
  return resolveSpecPath(parseManifest(await readFile(path, 'utf8'), path), path);
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
 */
function resolveSpecPath(manifest: ProviderManifest, source: string): ProviderManifest {
  const connector = manifest.connector;
  if (connector.kind !== 'http') return manifest;
  if (/^https?:/i.test(connector.openapi) || isAbsolute(connector.openapi)) return manifest;

  return {
    ...manifest,
    connector: { ...connector, openapi: resolve(dirname(source), connector.openapi) },
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

/** A starting point, written out by `lanes link provider new`. */
