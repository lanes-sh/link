import { describe, expect, test } from 'bun:test';
import { createWorkspaceRouter } from './router.ts';
import type { RequestHandler } from './index.ts';

/**
 * One process, many workspaces.
 *
 * A self-hosted deploy resolves `LANES_LINK_HOME` once at boot and serves one
 * workspace for the life of the process. A Lanes-hosted runtime serves many, so
 * something has to decide which one a request is for, build that workspace's
 * handler at most once, and let it go again when it has been idle.
 *
 * The unit under test is deliberately thin: `RequestHandler` is `{fetch,
 * close}`, so none of the endpoint's machinery is needed to pin what routing
 * must do. What it must never do — hand one workspace another's handler — is
 * the first test, and it is the whole reason this file exists.
 */

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** A handler that says which workspace it is, and records its own lifecycle. */
function fake(workspace: string) {
  const state = { closed: 0, served: 0, release: null as (() => void) | null };
  const handler: RequestHandler = {
    async fetch() {
      state.served += 1;
      if (state.release) {
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      }
      return new Response(workspace);
    },
    async close() {
      state.closed += 1;
    },
  };
  return { handler, state };
}

function router(options: { limit?: number } = {}) {
  const built = new Map<string, ReturnType<typeof fake>>();
  const opens: string[] = [];

  const handler = createWorkspaceRouter({
    // A workspace is the first label, and a bare domain names none — so
    // `example.com` is unplaceable rather than the workspace `example`.
    resolve: (request) => {
      const labels = new URL(request.url).hostname.split('.');
      return labels.length >= 3 ? (labels[0] ?? null) : null;
    },
    open: async (workspace) => {
      if (workspace === 'missing') throw new Error('no such workspace');
      opens.push(workspace);
      const made = fake(workspace);
      built.set(workspace, made);
      return made.handler;
    },
    log: silent,
    ...options,
  });

  return {
    handler,
    opens,
    built,
    get: (workspace: string) => handler.fetch(new Request(`https://${workspace}.example.com/mcp`)),
  };
}

describe('the workspace router', () => {
  test('serves each workspace from its own handler', async () => {
    const under = router();

    expect(await (await under.get('ws-aaa')).text()).toBe('ws-aaa');
    expect(await (await under.get('ws-bbb')).text()).toBe('ws-bbb');
  });

  test('builds a workspace handler once, however many requests arrive', async () => {
    const under = router();

    await under.get('ws-aaa');
    await under.get('ws-aaa');
    await under.get('ws-aaa');

    expect(under.opens).toEqual(['ws-aaa']);
  });

  test('refuses a request naming no workspace without building anything', async () => {
    const under = createWorkspaceRouter({
      resolve: () => null,
      open: async () => {
        throw new Error('open must not be called');
      },
      log: silent,
    });

    const response = await under.fetch(new Request('https://example.com/mcp'));
    expect(response.status).toBe(404);
  });

  test('refuses an unopenable workspace exactly as it refuses an unnamed one', async () => {
    // Probing must not be an oracle: a workspace that does not exist and one
    // whose bucket is briefly unreadable answer a caller identically, and the
    // difference goes to the log. ADR-007 makes this point about capabilities;
    // it is the same point one level up.
    const under = router();
    const unnamed = await under.handler.fetch(new Request('https://example.com/mcp'));
    const unopenable = await under.get('missing');

    expect(unopenable.status).toBe(unnamed.status);
    expect(await unopenable.text()).toBe(await unnamed.text());
  });

  test('does not cache a workspace that failed to open', async () => {
    const under = router();

    await under.get('missing');
    await under.get('missing');

    // Nothing was cached, so the second request tried again rather than
    // serving a rejection remembered from the first.
    expect(under.opens).toEqual([]);
  });

  test('evicts the least recently used workspace over the limit, and closes it', async () => {
    const under = router({ limit: 2 });

    await under.get('ws-aaa');
    await under.get('ws-bbb');
    await under.get('ws-aaa'); // ws-bbb is now the least recently used.
    await under.get('ws-ccc');

    expect(under.built.get('ws-bbb')?.state.closed).toBe(1);
    expect(under.built.get('ws-aaa')?.state.closed).toBe(0);

    // Evicted means gone, not forgotten-but-alive: reaching it again rebuilds.
    await under.get('ws-bbb');
    expect(under.opens).toEqual(['ws-aaa', 'ws-bbb', 'ws-ccc', 'ws-bbb']);
  });

  test('does not close a handler while a request is still in flight against it', async () => {
    const under = router({ limit: 1 });

    await under.get('ws-aaa');
    const first = under.built.get('ws-aaa');
    if (!first) throw new Error('ws-aaa was not built');

    // Hold one request open inside ws-aaa, then push it out of the cache.
    first.state.release = () => {};
    const held = under.get('ws-aaa');
    // Wait until the request is genuinely inside the handler rather than
    // relying on microtask ordering to have put it there.
    while (first.state.served === 0) await Bun.sleep(0);
    await under.get('ws-bbb');

    expect(first.state.closed).toBe(0);
    first.state.release?.();
    await held;

    // Closed once the last request drained, not before.
    await Bun.sleep(1);
    expect(first.state.closed).toBe(1);
  });

  test('closing the router closes every resident workspace', async () => {
    const under = router();

    await under.get('ws-aaa');
    await under.get('ws-bbb');
    await under.handler.close();

    expect(under.built.get('ws-aaa')?.state.closed).toBe(1);
    expect(under.built.get('ws-bbb')?.state.closed).toBe(1);
  });
});
