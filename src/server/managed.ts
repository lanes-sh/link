#!/usr/bin/env bun
import { controlRoutes } from '#control/routes.ts';
import { isControlPath } from '#control/routing.ts';
import { streamLogger } from './logging.ts';

/**
 * The entrypoint for a Lanes-hosted runtime.
 *
 * Not `container.ts`, and the difference is one that had to be found by trying
 * to run it: that entrypoint opens a runtime before it serves anything, and
 * `openReconciled` needs a profile to open. **A workspace that has just been
 * provisioned has none** — so the container refused to boot on exactly the
 * workspace whose control surface exists to create its first profile. Serving
 * configuration cannot depend on there being something configured.
 *
 * So this serves the control surface and nothing else. That is not a stopgap:
 * a managed workspace's data is reached through `api.lanes.sh/mcp` and proxied,
 * never by a client connecting here, and this service is
 * `--no-allow-unauthenticated` with the API's service account as the only
 * caller IAM admits (ADR-074). There is no `/mcp` for anybody to reach.
 *
 * **One workspace per process, for now.** `createWorkspaceRouter` is the map
 * that makes it many and it is wired in the next slice, along with the
 * per-workspace vault key — which is the part that must land before two
 * tenants ever share a process, because today `LANES_LINK_VAULT_KEY` is
 * read once for the whole of one.
 *
 * What the environment has to provide:
 *
 *   LANES_LINK_HOME            `lanes://<workspace-id>` — whose configuration
 *                       this serves. The workspace is also what the control
 *                       assertion must name, and a disagreement is refused.
 *   LANES_RUNTIME_PRIVATE_KEY  the key this runtime signs its own assertion
 *                       with, so it may read that workspace's bytes back
 *                       through the API. See `#control/identity.ts`.
 *   LANES_RUNTIME_ISSUER       who it claims to be, matching the API's
 *                       LINK_RUNTIME_ISSUER.
 *   LANES_CONTROL_PUBLIC_KEY   the API's signing key, so a control call can be
 *                       believed. Pinned, never discovered.
 *   LANES_CONTROL_ISSUER       who may have signed one.
 *   LANES_CONTROL_AUDIENCE     this service's own URL, so a stage-minted
 *                       assertion is not a prod one (ADR-072).
 *   LANES_API_URL              where the API is. Defaults to api.lanes.sh.
 *   PORT                       injected by Cloud Run. 8080 is its default.
 */

const env = process.env;

const log = (message: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
};

const refuse = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const port = Number(env['PORT'] ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  refuse(`PORT is ${JSON.stringify(env['PORT'])}, which is not a port number.`);
}
// Cloud Run routes to whatever the container listens on at $PORT, and a health
// check fails against a process bound to loopback.
const hostname = env['LANES_LINK_HOST'] ?? '0.0.0.0';

// Everything below imports `#control/**`, which package.json's `files` excludes
// from the published package — this file is only ever run from a checkout, so
// unlike `container.ts` it can import it statically.
const { controlDepsFrom } = await import('#control/boot.ts');
const { runtimeTokensFrom } = await import('#control/identity.ts');
const { lanesApiUrl, useLanesCredentials } = await import('#deployments/adapters/lanes.ts');

const apiUrl = lanesApiUrl(env);

// Before anything reads configuration. `workspaceFiles` builds a `lanes://`
// store on the first read and asks for the process's credential at call time,
// so a runtime that registered late would fail its own first read.
try {
  const tokens = await runtimeTokensFrom(env, apiUrl);
  if (!tokens) {
    refuse(
      'LANES_RUNTIME_PRIVATE_KEY is not set, so this runtime has nothing to present to the ' +
        'API and cannot read the workspace it was started to serve.',
    );
  }
  useLanesCredentials(tokens!);
} catch (error) {
  refuse((error as Error).message);
}

const deps = await (async () => {
  try {
    const built = await controlDepsFrom(env);
    if (!built) {
      refuse(
        'LANES_CONTROL_PUBLIC_KEY is not set, so nothing this service was sent could be ' +
          'believed. A managed runtime without it serves no control surface and has no ' +
          'other surface to serve.',
      );
    }
    return built!;
  } catch (error) {
    return refuse((error as Error).message);
  }
})();

const logger = streamLogger((line) => process.stdout.write(`${line}\n`));

const server = Bun.serve({
  port,
  hostname,
  async fetch(request) {
    const url = new URL(request.url);

    // Unauthenticated on purpose, and the only thing that is. Cloud Run's
    // startup probe has no credential to present, and IAM is what stands
    // between this and the internet — so a health check that required an
    // assertion would be a revision that never goes healthy.
    if (url.pathname === '/health') {
      return Response.json({ ok: true, workspace: deps.workspace });
    }

    if (isControlPath(url.pathname)) {
      return await controlRoutes(request, { ...deps, log: logger });
    }

    // Everything else, including `/mcp`. A client does not connect here; it
    // connects to `api.lanes.sh/mcp`, which reaches this over IAM. Answering
    // anything else would advertise a surface that is not meant to exist.
    return new Response('Not found', { status: 404 });
  },
});

log(`managed control surface on :${server.port} for workspace ${deps.workspace}`);
log(`reading its configuration through ${apiUrl}`);

// Cloud Run sends SIGTERM and waits; a process that ignores it is killed with
// requests in flight.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log(`${signal} received, closing`);
    void server.stop(false).then(() => process.exit(0));
  });
}
