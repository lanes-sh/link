import { describe, expect, test } from 'bun:test';
import type { Config, Resolution } from '#profile';
import { announceConnectTarget, deploymentGap } from './target-note.ts';

/**
 * Where `connect` says it is writing, and when it warns that you meant elsewhere.
 *
 * Testable without a runtime, a config file, or a credential store — which is
 * the reason this wording lives beside `outcome.ts` rather than inside the five
 * steps. The condition being pinned down here is the one that decides whether an
 * operator ever reads the line: a warning that fires on every local `connect`
 * gets tuned out long before the one deploy it was written for.
 */

function captured(body: () => void): { out: string; err: string } {
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string) => ((out += chunk), true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string) => ((err += chunk), true);

  try {
    body();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = outWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = errWrite;
  }

  return { out, err };
}

function targets(declared: Record<string, { deployed?: boolean }>): Config['targets'] {
  return Object.fromEntries(
    Object.entries(declared).map(([name, { deployed }]) => [
      name,
      {
        credentials: { adapter: 'file' },
        storage: { adapter: 'filesystem' },
        ...(deployed
          ? {
              deploy: {
                platform: 'cloudrun',
                region: 'europe-west1',
                service: `lanes-link-${name}`,
                access: 'public',
              },
            }
          : {}),
      },
    ]),
  ) as Config['targets'];
}

function at(target: string, source: Resolution['targetSource']) {
  return { target, targetSource: source };
}

describe('the deployment gap', () => {
  test('is silent when the target being written to is the deployed one', () => {
    const gap = deploymentGap(at('cloud', 'config-default'), targets({ local: {}, cloud: { deployed: true } }), 'gmail');

    expect(gap).toBeNull();
  });

  test('is silent when nothing is deployed, which is most profiles', () => {
    // The common case, and the one that decides whether this is a good idea:
    // somebody who has never deployed must never see a word about deployments.
    const gap = deploymentGap(at('local', 'config-default'), targets({ local: {} }), 'gmail');

    expect(gap).toBeNull();
  });

  test('is silent when --target named the local one on this command line', () => {
    // The house rule `target.ts` states for a conditional line: print it only
    // when the two disagree. A flag is the operator saying "local" in the same
    // breath, and the announce directly above already echoes `(flag)` back.
    // Without this, anyone genuinely running both targets sees the warning on
    // every local connect and stops reading it.
    const gap = deploymentGap(at('local', 'flag'), targets({ local: {}, cloud: { deployed: true } }), 'gmail');

    expect(gap).toBeNull();
  });

  test('fires for a config default, which is the case it exists for', () => {
    const gap = deploymentGap(at('local', 'config-default'), targets({ local: {}, cloud: { deployed: true } }), 'gmail');

    expect(gap).not.toBeNull();
    expect(gap!.join('\n')).toContain('lanes link connect gmail --target cloud');
  });

  test('fires for an exported variable, the source hardest to notice', () => {
    const gap = deploymentGap(at('local', 'environment'), targets({ local: {}, cloud: { deployed: true } }), 'gmail');

    expect(gap!.join('\n')).toContain('--target cloud');
  });

  test('names both targets, so the sentence says which is which', () => {
    const text = deploymentGap(
      at('local', 'config-default'),
      targets({ local: {}, cloud: { deployed: true } }),
      'gmail',
    )!.join('\n');

    expect(text).toContain('"local" declares no deployment');
    expect(text).toContain('"cloud"');
  });

  test('echoes the spec verbatim, so the command it prints is pasteable', () => {
    const declared = targets({ local: {}, cloud: { deployed: true } });

    // A named connection and a whole account are both legal specs, and both
    // have to survive into the suggested command — `connect icloud` is the
    // family case, where inventing `icloud_mail` here would be wrong.
    expect(deploymentGap(at('local', 'config-default'), declared, 'gmail.side')!.join('\n')).toContain(
      'lanes link connect gmail.side --target cloud',
    );
    expect(deploymentGap(at('local', 'config-default'), declared, 'icloud')!.join('\n')).toContain(
      'lanes link connect icloud --target cloud',
    );
  });

  test('refuses to pick when several targets are deployed', () => {
    // `resolveDeployTarget` throws rather than taking whichever came first in a
    // YAML mapping. A printed line should not be less careful than the resolver.
    const text = deploymentGap(
      at('local', 'config-default'),
      targets({ local: {}, cloud: { deployed: true }, staging: { deployed: true } }),
      'gmail',
    )!.join('\n');

    expect(text).toContain('<one of: cloud, staging>');
    expect(text).toContain('"cloud" and "staging"');
  });
});

describe('announcing the target', () => {
  const resolution: Resolution = {
    workspaceRoot: '/tmp/workspace',
    profile: 'personal',
    profilePath: '/tmp/workspace/profiles/personal.yaml',
    target: 'local',
    profileSource: 'workspace-default',
    targetSource: 'config-default',
  };

  const config = { targets: targets({ local: {}, cloud: { deployed: true } }) };

  test('writes nothing to stdout for a --json caller', () => {
    // The assertion is the parse. `emit` guards the lines printed at the emit,
    // and this one precedes the browser — so it carries its own guard, and a
    // stray line here would corrupt the document a caller is parsing.
    const { out } = captured(() => {
      announceConnectTarget({ resolution, config }, 'gmail', true);
      process.stdout.write(JSON.stringify({ ok: true }));
    });

    expect(() => JSON.parse(out)).not.toThrow();
  });

  test('names the profile, the target, and where each came from', () => {
    const { out } = captured(() => announceConnectTarget({ resolution, config }, 'gmail', false));

    expect(out).toContain('personal');
    expect(out).toContain('local');
    expect(out).toContain('config-default');
  });

  test('carries the warning on stdout beside the announce, not on stderr', () => {
    // Splitting the pair across channels would make the warning vanish for
    // anyone sending stdout to a file — which is when it is needed most.
    const { out, err } = captured(() => announceConnectTarget({ resolution, config }, 'gmail', false));

    expect(out).toContain('--target cloud');
    expect(err).toBe('');
  });
});
