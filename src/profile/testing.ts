import { SUPPORTED_CONTRACT } from './schema.ts';

/**
 * Workspace files for tests, so a fixture says what it is testing.
 *
 * Under contract 1 a test workspace needed only `contract` and a profile, because
 * the profile carried its own `targets:` block. The target is declared by the
 * workspace now (ADR-052), so every fixture that opens a store needs one here —
 * and thirty of them writing the same eight lines by hand is how a fixture ends
 * up subtly different from the thing it is standing in for.
 *
 * Kept beside the schema rather than under a test directory, following
 * `stores/blobs/testing.ts` and `stores/state/testing.ts`.
 */

/** The adapters each well-known test target gets. */
const ADAPTERS: Record<string, string> = {
  local: `    credentials: { adapter: file }
    storage: { adapter: filesystem }`,
  // Deployable, because that is what `cloud` means everywhere it is used as a
  // fixture: the tests that name it are about a target with a service in front
  // of it, and one without a `deploy:` block reads as an ordinary bucket.
  cloud: `    credentials: { adapter: gcp-secret-manager, project: my-project }
    storage: { adapter: gcs, bucket: your-bucket }
    vault: { adapter: secret }
    deploy:
      platform: cloudrun
      project: my-project
      region: europe-west1
      service: my-service`,
  staging: `    credentials: { adapter: gcp-secret-manager, project: staging-project }
    storage: { adapter: gcs, bucket: staging-bucket }`,
  s3: `    credentials: { adapter: file }
    storage:
      adapter: s3
      bucket: your-bucket
      endpoint: https://example.storage.example.com/storage/v1/s3
      region: eu-central-1
      access_key_id_ref: s3/access_key_id
      secret_access_key_ref: s3/secret_access_key`,
};

/**
 * A `lanes-link.yaml` declaring the named targets.
 *
 * Anything not in the table above is given the local adapters, which is what a
 * test naming an arbitrary target is nearly always after — it wants the name to
 * resolve, not the bytes to go anywhere in particular.
 */
export function workspaceYaml(
  targets: readonly string[] = ['local'],
  options: { defaultProfile?: string } = {},
): string {
  const blocks = targets
    .map((name) => `  ${name}:\n${ADAPTERS[name] ?? ADAPTERS['local']}`)
    .join('\n');

  return (
    `contract: ${SUPPORTED_CONTRACT}\n` +
    (options.defaultProfile ? `default_profile: ${options.defaultProfile}\n` : '') +
    `targets:\n${blocks}\n`
  );
}

/** A registry entry pointing at another workspace, for the pointer paths. */
export function pointerYaml(
  target: string,
  workspace: string,
  options: { defaultProfile?: string; alsoLocal?: boolean } = {},
): string {
  const local = options.alsoLocal === false ? '' : `  local:\n${ADAPTERS['local']}\n`;

  return (
    `contract: ${SUPPORTED_CONTRACT}\n` +
    (options.defaultProfile ? `default_profile: ${options.defaultProfile}\n` : '') +
    `targets:\n${local}  ${target}:\n    workspace: ${workspace}\n`
  );
}
