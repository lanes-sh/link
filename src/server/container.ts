#!/usr/bin/env bun
import { startEndpoint } from './endpoint.ts';

/**
 * The container entrypoint — `src/deployments/gcp/Dockerfile` runs this.
 *
 * Not `lanes link start`. That command is a terminal UI: it announces the
 * resolved profile with colour, mints a token if none exists, and expects
 * someone to be reading. A container needs the opposite of each — plain lines
 * on stdout for Cloud Logging, a refusal rather than an invention when the
 * token is missing, and a clean SIGTERM. Everything between those two is the
 * same `startEndpoint`, which is the point: the deployed instance runs the
 * same bootstrap as the local one, against a different adapter set.
 *
 * What the environment has to provide:
 *
 *   LANES_LINK_HOME     the workspace root, as `gs://<bucket>`. Set by
 *                      `lanes link deploy` at rollout rather than baked into
 *                      the image, because the bucket is the operator's and the
 *                      image is meant to serve any workspace (ADR-023).
 *                      Unset, `resolveWorkspaceRoot` falls back to
 *                      `~/.lanes-link`, which in a container is a directory
 *                      nobody wrote — so the endpoint refuses rather than
 *                      serving an empty workspace.
 *   LANES_LINK_TARGET   which target's adapters to open. Baked to `cloud`.
 *   LANES_LINK_PROFILE  optional; the workspace default otherwise.
 *   PORT               injected by Cloud Run. 8080 is its default.
 */

const env = process.env;

// Cloud Run routes to whatever the container listens on at $PORT, and health
// checks fail against a process bound to loopback.
const port = Number(env['PORT'] ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  // Refuse rather than fall back to a default: a container listening somewhere
  // other than where its platform routes is a startup probe that never passes,
  // reported as a health failure with nothing to explain it.
  process.stderr.write(`PORT is ${JSON.stringify(env['PORT'])}, which is not a port number.\n`);
  process.exit(1);
}
const host = env['LANES_LINK_HOST'] ?? '0.0.0.0';

const log = (message: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
};

try {
  const endpoint = await startEndpoint({
    flags: {
      ...(env['LANES_LINK_PROFILE'] ? { profile: env['LANES_LINK_PROFILE'] } : {}),
      ...(env['LANES_LINK_TARGET'] ? { target: env['LANES_LINK_TARGET'] } : {}),
      quiet: true,
    },
    port,
    host,
    // A deployed instance never mints its own token: see `endpoint.ts`.
    mintToken: false,
    reporter: {
      reconciled({ profile, plan }) {
        // Reconcile output is the record of what a deploy changed, and it is
        // the only place that record exists — the config it applied is baked
        // into an image that will be replaced.
        log(`reconciled ${profile}\n${plan}`);
      },
      tokenMinted() {},
    },
  });

  log(`serving ${endpoint.url}`);
  log(`profiles: ${endpoint.profiles.join(', ')}`);

  // Cloud Run sends SIGTERM and then waits. Closing the runtimes is what writes
  // each audit run's close marker, which is the difference between a run that
  // ended and one whose tail was cut off — see ADR-020.
  const shutdown = async (): Promise<void> => {
    log('shutting down');
    await endpoint.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await new Promise(() => {});
} catch (error) {
  // Exit non-zero so the revision fails to go healthy and Cloud Run keeps
  // serving the previous one, rather than rolling out an endpoint that answers
  // every request with an error.
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}
