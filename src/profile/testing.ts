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
    `workspaces:\n${blocks}\n`
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
    `workspaces:\n${local}  ${target}:\n    at: ${workspace}\n`
  );
}

/**
 * A `connections.yaml` holding the owner layer plus whatever a test names.
 *
 * Every fixture that opens a runtime needs one now: a profile's grants name rows
 * in this file, and `assertGrantsResolve` refuses a grant with nothing behind it
 * (ADR-057). Thirty tests writing the seven owner-layer rows by hand is how a
 * fixture ends up subtly different from what `newConnectionsTemplate` writes.
 */
export function connectionsYaml(
  extra: readonly { id: string; provider: string; account: string }[] = [],
): string {
  const owner = [
    { id: 'lan1', provider: 'lanes_memory', account: 'Memory' },
    { id: 'lan2', provider: 'lanes_tasks', account: 'Tasks' },
    { id: 'lan3', provider: 'lanes_assets', account: 'Assets' },
    { id: 'lan4', provider: 'lanes_skills', account: 'Skills' },
    { id: 'lan5', provider: 'lanes_vault', account: 'Vault' },
    { id: 'lan6', provider: 'lanes_setup', account: 'Setup' },
    { id: 'lan7', provider: 'lanes_entities', account: 'Entities' },
  ];

  const rows = [...owner, ...extra]
    .map((row) => `  - { id: ${row.id}, provider: ${row.provider}, account: ${row.account} }`)
    .join('\n');

  return `contract: ${SUPPORTED_CONTRACT}\nconnections:\n${rows}\noauth_apps: {}\n`;
}

/** The owner-layer grant rows a fresh profile carries, plus whatever a test names. */
export function grantsYaml(
  extra: readonly { connection: string; allow?: readonly string[]; deny?: readonly string[] }[] = [],
): string {
  const owner = [
    'lanes_memory',
    'lanes_tasks',
    'lanes_assets',
    'lanes_skills',
    'lanes_vault',
    'lanes_setup',
    'lanes_entities',
  ].map((provider, index) => ({
    connection: `${provider}.lan${index + 1}`,
    allow: [`${provider}.*`],
    deny: [],
  }));

  return [...owner, ...extra]
    .map(
      (grant) =>
        `  - { connection: ${grant.connection}, allow: [${(grant.allow ?? []).join(', ')}], ` +
        `deny: [${(grant.deny ?? []).join(', ')}] }`,
    )
    .join('\n');
}

/** A whole profile document at the current contract, for a test that needs one. */
export function profileYaml(
  profile: string,
  options: {
    port?: number;
    grants?: readonly { connection: string; allow?: readonly string[]; deny?: readonly string[] }[];
    members?: readonly string[];
  } = {},
): string {
  const members = (options.members ?? [])
    .map((subject) => `  - { subject: ${subject}, role: owner }`)
    .join('\n');

  return (
    `contract: ${SUPPORTED_CONTRACT}\n` +
    `instance:\n  profile: ${profile}\n  port: ${options.port ?? 7337}\n  host: 127.0.0.1\n` +
    `auth:\n  mode: bearer\n  token_ref: profile/token\n` +
    `grants:\n${grantsYaml(options.grants ?? [])}\n` +
    `members:${members ? `\n${members}` : ' []'}\n`
  );
}

/**
 * Write a profile's declaration into a fixture workspace.
 *
 * A profile is a directory now (ADR-067), so writing one means creating that
 * directory — which every fixture that used to write `profiles/<name>.yaml`
 * beside its siblings got for free. Centralised here rather than repeated in
 * twenty test files, for the reason `layout.ts` exists at all: the last time a
 * path was spelled in two places one of them went stale, and the failure was a
 * listing that disagreed with a loader about what existed.
 */
export async function writeProfileFixture(
  root: string,
  profile: string,
  body: string,
): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { layout } = await import('./layout.ts');

  const path = join(root, layout.profileConfig(profile));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return path;
}
