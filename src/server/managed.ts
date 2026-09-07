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
 * **Many workspaces, one process, and no `LANES_LINK_HOME`.** Every control
 * route already derives its root, its environment and its workspace from the
 * verified assertion (`workspaceRootFor`, `environmentFor`), so the only thing
 * that was ever per-process about this surface was which workspace it claimed
 * to be. That is decided per request here.
 *
 * The vault key follows the same rule and had to be fixed for it:
 * `LANES_LINK_VAULT_KEY` is read once per process, so before
 * `#secrets/derived.ts` every tenant's vault would have been sealed under one
 * key. It is now a master that each workspace derives its own from.
 *
 * What the environment has to provide:
 *
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
const { controlVerifierFrom } = await import('#control/boot.ts');
const { runtimeTokensFrom } = await import('#control/identity.ts');
const { lanesApiUrl, useLanesCredentials } = await import('#deployments/adapters/lanes.ts');
const { assertEnvironmentMatches, environmentFrom } = await import('#deployments/environment.ts');

const apiUrl = lanesApiUrl(env);

/**
 * ADR-072's guard, called by something other than its own test at last.
 *
 * `LANES_ENV` is required of anything that is not talking to a local API. A
 * deployed revision that declared no environment would get no check at all,
 * which is the exact failure the ADR exists for — so the absence is refused
 * rather than defaulted, and a local run is recognised by its API being on this
 * machine rather than by a variable somebody could also forget.
 */
const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(apiUrl);
if (env['LANES_ENV'] !== undefined || !local) {
  try {
    const environment = environmentFrom(env['LANES_ENV']);
    // The API URL is the derived location this service actually has. The
    // storage root is per workspace and arrives with the assertion, so there
    // is no process-wide one to check — which is itself a consequence of
    // serving many workspaces.
    assertEnvironmentMatches({ environment, what: 'LANES_API_URL', value: apiUrl });
    log(`environment ${environment}`);
  } catch (error) {
    refuse((error as Error).message);
  }
} else {
  log('no LANES_ENV set and the API is local, so no environment check applies');
}

// Before anything reads configuration. `workspaceFiles` builds a `lanes://`
// store on the first read and asks for the process's credential at call time,
// so a runtime that registered late would fail its own first read.
try {
  // `requireManagedRoot: false` — this service has no root of its own. Every
  // workspace it serves is named by the assertion that arrives, so the key is
  // required unconditionally rather than because of where bytes live.
  const tokens = await runtimeTokensFrom(env, apiUrl, { requireManagedRoot: false });
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

const verifier = await (async () => {
  try {
    const built = await controlVerifierFrom(env);
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

/**
 * Which workspace a request is for, read from the token without verifying it.
 *
 * Safe, and worth saying why rather than leaving it to look like a shortcut.
 * This decides *routing* only. `controlRoutes` then verifies the signature
 * properly and refuses unless the assertion names the same workspace it was
 * dispatched for — so a forged claim routes somewhere and is then turned away
 * by the signature check, exactly as an unforged one for the wrong workspace
 * would be.
 *
 * The alternative was a hostname per workspace, which is what
 * `createWorkspaceRouter` was written against. ADR-074 made this service
 * private with no hostname anybody resolves, so that statement no longer
 * exists to be had. The agreement check stays anyway: it costs nothing and it
 * still catches the case where routing and verification disagree.
 */
function workspaceOf(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;

  const middle = token.split('.')[1];
  if (!middle) return null;
  try {
    const padded = middle.replaceAll('-', '+').replaceAll('_', '/');
    const claims = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as {
      workspace?: unknown;
    };
    return typeof claims.workspace === 'string' && claims.workspace.length > 0
      ? claims.workspace
      : null;
  } catch {
    // Unparseable is not an error here: it is a token that will not verify
    // either, and the refusal belongs to the verifier so there is one answer
    // for every way a statement can fail to convince.
    return null;
  }
}

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
      return Response.json({ ok: true });
    }

    if (isControlPath(url.pathname)) {
      const workspace = workspaceOf(request);
      // One answer for a token that names no workspace and for one that names
      // a workspace nothing will admit. A caller able to tell them apart could
      // enumerate tenants by watching which ids answer differently, which is
      // ADR-007's argument one level up.
      if (workspace === null) return Response.json({ error: 'unauthenticated' }, { status: 401 });

      return await controlRoutes(request, { workspace, verifier, log: logger });
    }

    // Everything else, including `/mcp`. A client does not connect here; it
    // connects to `api.lanes.sh/mcp`, which reaches this over IAM. Answering
    // anything else would advertise a surface that is not meant to exist.
    return new Response('Not found', { status: 404 });
  },
});

log(`managed control surface on :${server.port}, serving whichever workspace is asserted`);
log(`reading its configuration through ${apiUrl}`);

// Cloud Run sends SIGTERM and waits; a process that ignores it is killed with
// requests in flight.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log(`${signal} received, closing`);
    void server.stop(false).then(() => process.exit(0));
  });
}
