import { afterAll, describe, expect, test } from 'bun:test';
import { isValidSecretRef } from '#secrets';
import { pair, pairingLink, PAIR_CERT_REF, PAIR_KEY_REF, PAIR_TOKEN_REF } from './pair.ts';

/**
 * The three references `lanes link pair` writes.
 *
 * A constant that is never validated until somebody runs the command is a
 * constant that is wrong until somebody runs the command. These were
 * `workspace/pair.cert` and friends, which `isValidSecretRef` refuses — a
 * secret reference is `[a-z0-9_-]` between slashes, because these names become
 * Secret Manager entries on a deployed workspace and Google allows no dots
 * either. The command failed on its first real invocation, having passed every
 * test in the suite.
 */

describe('the pairing credential references', () => {
  test.each([
    ['token', PAIR_TOKEN_REF],
    ['certificate', PAIR_CERT_REF],
    ['key', PAIR_KEY_REF],
  ])('the %s reference is one a store will accept', (_name, ref) => {
    expect(isValidSecretRef(ref)).toBe(true);
  });

  test('all three are distinct, so none overwrites another', () => {
    expect(new Set([PAIR_TOKEN_REF, PAIR_CERT_REF, PAIR_KEY_REF]).size).toBe(3);
  });

  test('they share a namespace that says what owns them', () => {
    // `workspace/` rather than `profile/`: pairing is a property of the machine
    // and its workspace, not of any one profile, and the read surface it opens
    // lists every profile there.
    for (const ref of [PAIR_TOKEN_REF, PAIR_CERT_REF, PAIR_KEY_REF]) {
      expect(ref.startsWith('workspace/')).toBe(true);
    }
  });
});

/**
 * The link the browser opens, which nothing used to assert on.
 *
 * A loopback link carried no address for as long as loopback looked derivable.
 * It is not: the read listener sits one port above `instance.port`, so an
 * endpoint on any port but the default printed a link the dashboard then read at
 * 7338, reported unreachable, and gave no way to correct — a silent failure in a
 * command that had reported success.
 *
 * These read the fragment rather than the whole string, because the origin comes
 * from `LANES_WEB_URL` and is a local dashboard as often as it is lanes.sh.
 */

function fragment(url: string): URLSearchParams {
  return new URLSearchParams(new URL(url).hash.replace(/^#/, ''));
}

describe('the pairing link', () => {
  test('carries the address, so a non-default port survives the trip', () => {
    const parsed = fragment(pairingLink('llp_token', 'https://127.0.0.1:7401'));
    expect(parsed.get('at')).toBe('https://127.0.0.1:7401');
  });

  test('carries a deployed address the same way', () => {
    const parsed = fragment(pairingLink('llp_token', 'https://link.example.test'));
    expect(parsed.get('at')).toBe('https://link.example.test');
  });

  test('puts both in the fragment, never in the query', () => {
    // The fragment is never sent to a server, which is the whole reason a
    // credential for a surface Lanes cannot see may travel in a URL at all. An
    // address in the query would put a workspace's public address in an access
    // log for the same trip.
    const url = new URL(pairingLink('llp_token', 'https://127.0.0.1:7338'));
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/dashboard/link');
    expect(fragment(url.href).get('pair')).toBe('llp_token');
  });

  test('encodes the address, so its own separators do not end the parameter', () => {
    const raw = new URL(pairingLink('llp_token', 'https://127.0.0.1:7401')).hash;
    expect(raw).toContain('at=https%3A%2F%2F127.0.0.1%3A7401');
  });
});

/**
 * Which endpoint a workspace is paired at, when its profiles do not agree on a
 * port.
 *
 * The port refusal is right on loopback and was wrong everywhere else, because
 * it was asked before the thing that decides the address. A deployed workspace
 * is reached at the URL the platform assigned it — one service, in front of
 * every profile in the workspace — and `instance.port` is not part of that URL,
 * is not what the revision binds, and is not consulted anywhere on that path.
 * Two profiles created on different days therefore refused to pair at all, and
 * the `--profile` the refusal demanded settled nothing: both answers produce
 * the same link, which is the assertion below that says why this is a bug
 * rather than a preference.
 *
 * These run `pair` itself rather than a helper, because the defect was an
 * ordering between two checks and neither check is wrong in isolation.
 */

const homes: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

/**
 * A workspace holding two profiles on different ports.
 *
 * `edge` declares a deployment and keeps the *file* adapters, which is not a
 * combination a real deploy produces and is deliberate here: the target's
 * cloud adapters have nothing to do with what is being tested, and reaching
 * Secret Manager to assert an ordering would make this a test of the network.
 *
 * `LANES_LINK_HOME` is set before anything calls `pair`, and that is not
 * hygiene. `resolveWorkspaceRoot` falls back to `~/.lanes-link` when nothing
 * names a root — so a test that forgot this would mint a pairing token into
 * whoever ran it's real workspace.
 */
async function twoProfiles(ports: Record<string, number>): Promise<string> {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SUPPORTED_CONTRACT } = await import('#profile');
  const { writeProfileFixture } = await import('#profile/testing.ts');

  const root = await mkdtemp(join(tmpdir(), 'lanes-link-pair-'));
  homes.push(root);
  process.env['LANES_LINK_HOME'] = root;

  await writeFile(
    join(root, 'workspaces.yaml'),
    `contract: ${SUPPORTED_CONTRACT}\n` +
      'workspaces:\n' +
      '  here:\n' +
      '    credentials: { adapter: file }\n' +
      '    storage: { adapter: filesystem }\n' +
      '  edge:\n' +
      '    credentials: { adapter: file }\n' +
      '    storage: { adapter: filesystem }\n' +
      '    deploy:\n' +
      '      platform: cloudrun\n' +
      '      project: my-project\n' +
      '      region: europe-west1\n' +
      '      service: my-service\n',
  );

  for (const [profile, port] of Object.entries(ports)) {
    await writeProfileFixture(
      root,
      profile,
      `contract: ${SUPPORTED_CONTRACT}\n` +
        `instance: { profile: ${profile}, port: ${port}, host: 127.0.0.1 }\n`,
    );
  }

  return root;
}

/** The address `pair` is told the platform assigned, instead of asking it. */
const DEPLOYED = { address: async () => 'https://link.example.test/mcp' };

/** Everything written to stdout while `body` runs. */
async function captureStdout(body: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };

  try {
    await body();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
  }

  return captured;
}

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(homes.map((root) => rm(root, { recursive: true, force: true })));
});

describe('pairing a workspace whose profiles disagree on a port', () => {
  test('deployed, it pairs without being told which profile', async () => {
    await twoProfiles({ personal: 7337, projects: 7338 });

    const printed = await captureStdout(async () => {
      await pair({ target: 'edge' }, DEPLOYED);
    });

    expect(printed).toContain('at=https%3A%2F%2Flink.example.test');
    expect(printed).not.toContain('do not agree on a port');
  });

  test('deployed, naming a profile changes nothing about the link', async () => {
    // The whole of the argument. A refusal that can be settled by either answer
    // was not resolving an ambiguity; it was asking a question with no bearing
    // on the outcome, and stopping until it got one.
    await twoProfiles({ personal: 7337, projects: 7338 });

    const first = await captureStdout(async () => {
      await pair({ target: 'edge', profile: 'personal' }, DEPLOYED);
    });
    const second = await captureStdout(async () => {
      await pair({ target: 'edge', profile: 'projects' }, DEPLOYED);
    });

    expect(link(first)).toBe(link(second));
  });

  test('deployed, a profile the workspace does not hold is still refused', async () => {
    // `--profile` decides nothing here, which is not the same as meaning
    // nothing: a name that is not in the workspace is a typo either way, and
    // accepting it silently would teach that the flag was read.
    await twoProfiles({ personal: 7337, projects: 7338 });

    await expect(pair({ target: 'edge', profile: 'personel' }, DEPLOYED)).rejects.toThrow(
      'has no profile "personel"',
    );
  });

  test('on loopback, the ambiguity is real and is still refused', async () => {
    // The guard on the fix. Here the port *is* the address — the read listener
    // sits one above `instance.port` — so picking one of two would pair a
    // dashboard to an endpoint that is not the one being run.
    await twoProfiles({ personal: 7337, projects: 7338 });

    await expect(pair({ target: 'here' }, DEPLOYED)).rejects.toThrow('do not agree on a port');
  });
});

/** The pairing link out of a captured run, so two runs can be compared. */
function link(printed: string): string {
  const found = printed.match(/https?:\/\/\S*#pair=\S+/);
  expect(found).not.toBeNull();
  return found![0];
}
