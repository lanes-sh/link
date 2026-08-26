import { describe, expect, test } from 'bun:test';
import { parseConfig } from '#profile';
import { conflictsIn, diffConfigs, keyedArrayFor } from './sync.ts';

/**
 * Finding what one copy of a profile holds and the other has lost.
 *
 * The case every test here is written against is real: a profile file was
 * rewritten locally and lost `targets.cloud`, `auth.authorization`, and six
 * connections, while the bucket the endpoint reads from still held all of it.
 */

const profile = (body: string, port = 7337): ReturnType<typeof parseConfig>['config'] =>
  parseConfig(
    `contract: 1\ninstance: { profile: personal, port: ${port} }\n` +
      `targets:\n  local:\n    credentials: { adapter: file, path: ./data/personal/credentials.enc }\n` +
      `    storage: { adapter: filesystem, path: ./data/personal }\n${body}`,
  ).config;

const CLOUD = `  cloud:
    credentials: { adapter: gcp-secret-manager, project: my-project }
    storage: { adapter: gcs, bucket: your-bucket }
    vault: { adapter: secret }
`;

const at = (changes: ReturnType<typeof diffConfigs>, path: string) =>
  changes.find((change) => change.path.join('.') === path);

describe('diffing a profile against its deployed copy', () => {
  test('two identical copies differ in nothing', () => {
    expect(diffConfigs(profile(''), profile(''))).toEqual([]);
  });

  test('a target only the deployment still has is a pull', () => {
    // The reported case, reduced: local lost the block, the bucket kept it.
    const changes = diffConfigs(profile(''), profile(CLOUD));

    expect(at(changes, 'targets.cloud')?.direction).toBe('pull');
    expect(at(changes, 'targets.cloud')?.remote).toMatchObject({
      storage: { adapter: 'gcs', bucket: 'your-bucket' },
    });
  });

  test('a target only the local copy has is a push', () => {
    expect(at(diffConfigs(profile(CLOUD), profile('')), 'targets.cloud')?.direction).toBe('push');
  });

  test('a change reports at the narrowest path that describes it', () => {
    // Not `auth`: applying that would carry `token_ref` along with it.
    const changes = diffConfigs(
      profile('auth: { mode: bearer, token_ref: profile/token }\n'),
      profile('auth:\n  mode: bearer\n  token_ref: profile/token\n  authorization: { mode: self }\n'),
    );

    expect(changes.map((change) => change.path.join('.'))).toEqual(['auth.authorization']);
    expect(changes[0]!.direction).toBe('pull');
  });

  test('the same key set differently on both sides is a conflict', () => {
    const changes = diffConfigs(profile('', 7337), profile('', 7339));

    const conflict = at(changes, 'instance.port');
    expect(conflict?.direction).toBe('conflict');
    expect(conflict?.local).toBe(7337);
    expect(conflict?.remote).toBe(7339);
    expect(conflictsIn(changes)).toHaveLength(1);
  });

  test('a whole profile only one side has is reported at the root', () => {
    // The unit that has to be copied is the file, so there is no narrower path.
    expect(diffConfigs(undefined, profile(''))).toMatchObject([{ path: [], direction: 'pull' }]);
    expect(diffConfigs(profile(''), undefined)).toMatchObject([{ path: [], direction: 'push' }]);
    expect(diffConfigs(undefined, undefined)).toEqual([]);
  });
});

describe('connections, which are a set and not a list', () => {
  const withConnections = (entries: string): string =>
    `connections:\n${entries}policy:\n  allow: []\n`;

  const gmail = '  - { id: work, provider: gmail, account: someone@example.com }\n';
  const drive = '  - { id: work, provider: drive, account: someone@example.com }\n';

  test('an account only the deployment has names itself', () => {
    const changes = diffConfigs(
      profile(withConnections(gmail)),
      profile(withConnections(gmail + drive)),
    );

    expect(at(changes, 'connections.drive.work')?.direction).toBe('pull');
  });

  test('reordering is not a change, which positional comparison would call one', () => {
    expect(
      diffConfigs(profile(withConnections(gmail + drive)), profile(withConnections(drive + gmail))),
    ).toEqual([]);
  });

  test('an added account is not read as a change to the one at that index', () => {
    // The failure keyed comparison exists to prevent: positionally, adding
    // `drive` first would report `gmail.work` as having become `drive.work`.
    const changes = diffConfigs(
      profile(withConnections(gmail)),
      profile(withConnections(drive + gmail)),
    );

    expect(changes.map((change) => change.path.join('.'))).toEqual(['connections.drive.work']);
  });

  test('the same account differing in one field is a conflict on that field', () => {
    const changes = diffConfigs(
      profile(withConnections('  - { id: work, provider: gmail, account: one@example.com }\n')),
      profile(withConnections('  - { id: work, provider: gmail, account: two@example.com }\n')),
    );

    expect(at(changes, 'connections.gmail.work.account')?.direction).toBe('conflict');
  });

  test('policy rules compare by capability, not position', () => {
    // A rule must name a provider that has a connection, so both sides carry
    // both accounts and differ only in what is granted.
    const both = gmail + drive;
    const changes = diffConfigs(
      profile(`connections:\n${both}policy:\n  allow: [gmail.*]\n`),
      profile(`connections:\n${both}policy:\n  allow: [drive.*, gmail.*]\n`),
    );

    expect(at(changes, 'policy.allow.drive.*')?.direction).toBe('pull');
  });

  test('identity stays an ordered list, because its order is meaningful', () => {
    // The first entry of a kind is the one to reach for, so a reorder is a
    // change and must not be silently merged away.
    const changes = diffConfigs(
      profile('identity:\n  - { kind: email, value: a@example.com }\n  - { kind: email, value: b@example.com }\n'),
      profile('identity:\n  - { kind: email, value: b@example.com }\n  - { kind: email, value: a@example.com }\n'),
    );

    expect(at(changes, 'identity')?.direction).toBe('conflict');
  });
});

describe('knowing which array a change belongs to', () => {
  test('an element resolves to the array that has to be rewritten', () => {
    expect(keyedArrayFor(['connections', 'gmail.work'])).toEqual(['connections']);
    expect(keyedArrayFor(['connections', 'gmail.work', 'account'])).toEqual(['connections']);
  });

  test('the deeper array wins, so policy.allow is not read as policy', () => {
    expect(keyedArrayFor(['policy', 'allow', 'gmail.*'])).toEqual(['policy', 'allow']);
  });

  test('a path in no keyed array belongs to none', () => {
    expect(keyedArrayFor(['targets', 'cloud'])).toBeUndefined();
    expect(keyedArrayFor([])).toBeUndefined();
  });
});
