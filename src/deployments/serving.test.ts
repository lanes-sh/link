import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collidingRefs, collisionRefusal, servingProfiles } from './serving.ts';

/**
 * Which profiles a deploy sends, and whether they can share one store.
 *
 * The set is the easy half. The collision check is the one that matters: it is
 * the only thing standing between "deploy every profile" and one profile's
 * refresh token silently replacing another's, after which both still name their
 * own account in config and one of them reads the other's mailbox.
 */

const roots: string[] = [];

function profileYaml(name: string, options: { cloud?: boolean; gmail?: string } = {}): string {
  return (
    `contract: 1\ninstance: { profile: ${name} }\ntargets:\n` +
    `  local:\n    credentials: { adapter: file, path: ./data/${name}/credentials.enc }\n` +
    `    storage: { adapter: filesystem, path: ./data/${name} }\n` +
    (options.cloud === true
      ? `  cloud:\n    credentials: { adapter: gcp-secret-manager, project: my-project }\n` +
        `    storage: { adapter: gcs, bucket: your-bucket }\n    vault: { adapter: secret }\n` +
        `    deploy: { platform: cloudrun, project: my-project, region: europe-west1, service: s-${name} }\n`
      : '') +
    `connections:\n  - { id: main, provider: setup, account: Setup }\n` +
    (options.gmail
      ? `  - { id: ${options.gmail}, provider: gmail, account: ${name}@example.com }\n`
      : '') +
    `policy:\n  allow: [setup.*${options.gmail ? ', gmail.*' : ''}]\n`
  );
}

async function workspace(
  profiles: Record<string, string>,
  workspaceFile = 'contract: 1\n',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-serving-'));
  roots.push(root);

  await writeFile(join(root, 'lanes-link.yaml'), workspaceFile);
  await mkdir(join(root, 'profiles'), { recursive: true });
  for (const [name, body] of Object.entries(profiles)) {
    await writeFile(join(root, 'profiles', `${name}.yaml`), body);
  }
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('deciding which profiles a deploy sends', () => {
  test('every profile declaring the target, when none is named', async () => {
    const root = await workspace(
      {
        personal: profileYaml('personal', { cloud: true }),
        work: profileYaml('work', { cloud: true }),
        solo: profileYaml('solo'),
      },
      // A recorded primary, so this asserts the set rather than tripping the
      // separate refusal about whose token opens the endpoint.
      'contract: 1\ndeployments:\n  - { target: cloud, workspace: "gs://your-bucket", primary: personal }\n',
    );

    const serving = await servingProfiles({
      workspaceRoot: root,
      target: 'cloud',
      named: [],
    });

    // `solo` declares only `local`, so the endpoint would never open it.
    expect(serving.profiles).toEqual(['personal', 'work']);
  });

  test('--profile narrows the set rather than selecting from nothing', async () => {
    const root = await workspace({
      personal: profileYaml('personal', { cloud: true }),
      work: profileYaml('work', { cloud: true }),
    });

    const serving = await servingProfiles({
      workspaceRoot: root,
      target: 'cloud',
      named: ['work'],
    });

    expect(serving.profiles).toEqual(['work']);
    expect(serving.primary).toBe('work');
  });

  test('one profile declaring it is the primary without being asked', async () => {
    const root = await workspace({ personal: profileYaml('personal', { cloud: true }) });

    expect((await servingProfiles({ workspaceRoot: root, target: 'cloud', named: [] })).primary).toBe(
      'personal',
    );
  });

  test('two, with nothing recorded, refuses rather than picking', async () => {
    // One token opens the endpoint and reaches every profile behind it, so
    // which profile owns it decides who gets in.
    const root = await workspace({
      personal: profileYaml('personal', { cloud: true }),
      work: profileYaml('work', { cloud: true }),
    });

    await expect(
      servingProfiles({ workspaceRoot: root, target: 'cloud', named: [] }),
    ).rejects.toThrow("owns the endpoint's token");
  });

  test('and takes the recorded primary once a deploy has named one', async () => {
    const root = await workspace(
      {
        personal: profileYaml('personal', { cloud: true }),
        work: profileYaml('work', { cloud: true }),
      },
      'contract: 1\ndeployments:\n  - { target: cloud, workspace: "gs://your-bucket", primary: work }\n',
    );

    const serving = await servingProfiles({ workspaceRoot: root, target: 'cloud', named: [] });
    expect(serving.primary).toBe('work');
    expect(serving.profiles).toEqual(['personal', 'work']);
  });

  test('a target nothing declares says a first deploy has to name a profile', async () => {
    // There is no set to derive, and inventing one would create cloud
    // resources for a profile nobody chose.
    const root = await workspace({ personal: profileYaml('personal') });

    await expect(
      servingProfiles({ workspaceRoot: root, target: 'cloud', named: [] }),
    ).rejects.toThrow('has to be told which profile');
  });

  test('and points at sync, because a lost declaration looks the same', async () => {
    const root = await workspace({ personal: profileYaml('personal') });

    await expect(
      servingProfiles({ workspaceRoot: root, target: 'cloud', named: [] }),
    ).rejects.toThrow('sync targets');
  });
});

describe('two profiles sharing one credential store', () => {
  test('the same connection id in both is a collision', async () => {
    // `gmail/main` is one secret in one project. The last deploy wins, and
    // nothing downstream can catch it — by then the credential is valid.
    const root = await workspace({
      personal: profileYaml('personal', { cloud: true, gmail: 'main' }),
      work: profileYaml('work', { cloud: true, gmail: 'main' }),
    });

    const found = await collidingRefs(root, ['personal', 'work']);
    expect(found).toMatchObject([{ ref: 'gmail/main', profiles: ['personal', 'work'] }]);
  });

  test('different ids are not', async () => {
    const root = await workspace({
      personal: profileYaml('personal', { cloud: true, gmail: 'main' }),
      work: profileYaml('work', { cloud: true, gmail: 'desk' }),
    });

    expect(await collidingRefs(root, ['personal', 'work'])).toEqual([]);
  });

  test('one profile alone can never collide with itself', async () => {
    const root = await workspace({
      personal: profileYaml('personal', { cloud: true, gmail: 'main' }),
      work: profileYaml('work', { cloud: true, gmail: 'main' }),
    });

    expect(await collidingRefs(root, ['personal'])).toEqual([]);
  });

  test('the shared endpoint token is not a collision, because sharing it is the design', async () => {
    // Every profile defaults to `profile/token`, and ADR-009 says one endpoint
    // has one token. Reporting it would fire on every multi-profile deploy.
    const root = await workspace({
      personal: profileYaml('personal', { cloud: true }),
      work: profileYaml('work', { cloud: true }),
    });

    expect(await collidingRefs(root, ['personal', 'work'])).toEqual([]);
  });

  test('the refusal names the reference and both profiles', async () => {
    const message = collisionRefusal(
      [{ ref: 'gmail/main', profiles: ['personal', 'work'] }],
      'cloud',
    );

    expect(message).toContain('gmail/main   personal, work');
    expect(message).toContain('the last deploy');
    expect(message).toContain('separate projects');
  });
});
