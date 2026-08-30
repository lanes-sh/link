import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfile } from '../profile.ts';
import { entitiesFind, entitiesForget, entitiesLink, entitiesWrite } from './entities.ts';

/**
 * `lanes link entities`, through what it actually prints.
 *
 * These exist because of a bug that no other kind of test would have caught.
 * `warn` is a *formatter* — it returns a string, like `ok` — and calling it as
 * a bare statement type-checks, runs, and silently prints nothing. Both places
 * this command warns were written that way, so `forget` removed an entity that
 * three others pointed at and said nothing about it, and `link` accepted an
 * edge to an undeclared id in silence.
 *
 * Both of those warnings are the *entire* mitigation for a deliberate design
 * choice: `forget` does not cascade, and a dangling edge is legal. A warning
 * that does not print turns "we tell you so you can decide" into "it happens
 * and you find out later", which is a different product.
 *
 * So what is asserted here is output, not return values. The unit tests in
 * `#providers/entities` cover the behaviour; this covers whether a person is
 * told about it.
 */

const WHERE = { profile: 'personal', target: 'local' } as const;

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

/**
 * Pretend stdin is a terminal, which is the "no notes were piped" branch.
 *
 * `optionalStdin` reads `Bun.stdin.text()` when stdin is not a TTY, and under
 * `bun test` stdin is neither a TTY nor ever closed — so the read never
 * resolves and every test after the first hangs. Flipping the flag takes the
 * branch these tests mean: `entities write` with its notes left out.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const previousTty = (process.stdin as any).isTTY;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stdin as any).isTTY = true;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-entities-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;
  await createProfile('personal', { targets: ['local'] });
  return root;
}

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdin as any).isTTY = previousTty;
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

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

async function declareTwo(): Promise<void> {
  await captureStdout(() =>
    entitiesWrite('Acme B.V.', { ...WHERE, name: 'acme-bv', type: 'company' }),
  );
  await captureStdout(() =>
    entitiesWrite('Jan Bakker', {
      ...WHERE,
      type: 'person',
      alias: ['Jan'],
      attr: ['email=jan@acme.test'],
      related: ['works_at=acme-bv'],
    }),
  );
}

describe('what the command tells the person', () => {
  test('forget says who still points at what it removed', async () => {
    await workspace();
    await declareTwo();

    const output = await captureStdout(() => entitiesForget('acme-bv', { ...WHERE, yes: true }));

    // The whole mitigation for not cascading. Without it, an entity vanishes
    // and three other files quietly point at nothing.
    expect(output).toContain('still referenced by jan-bakker');
    expect(output).toContain('removed entity');
  });

  test('link says when the other end is not declared yet', async () => {
    await workspace();
    await declareTwo();

    const output = await captureStdout(() =>
      entitiesLink('jan-bakker', 'knows=nobody-yet', { ...WHERE }),
    );

    // Legal and kept — a name written before the person is — but silence here
    // makes a typo in an id indistinguishable from a deliberate forward
    // reference.
    expect(output).toContain('not declared yet');
  });

  test('a listing of several says the order is not a ranking', async () => {
    await workspace();
    await declareTwo();
    await captureStdout(() =>
      entitiesWrite('Jan de Vries', { ...WHERE, type: 'person', alias: ['Jan'] }),
    );

    const output = await captureStdout(() => entitiesFind('Jan', { ...WHERE }));

    expect(output).toContain('jan-bakker');
    expect(output).toContain('jan-de-vries');
    expect(output).toContain('the order is not a ranking');
  });

  test('one match does not claim to be a choice between several', async () => {
    await workspace();
    await declareTwo();

    const output = await captureStdout(() => entitiesFind('Jan', { ...WHERE }));

    expect(output).toContain('jan-bakker');
    expect(output).not.toContain('the order is not a ranking');
  });

  test('an empty profile says how to declare the first one', async () => {
    await workspace();

    const output = await captureStdout(() => entitiesFind(undefined, { ...WHERE }));

    expect(output).toContain('lanes link entities write');
  });
});
