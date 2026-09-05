#!/usr/bin/env bun
import { startEndpoint } from './endpoint.ts';
import { streamLogger } from './logging.ts';

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
 *   LANES_LINK_PROFILE  the primary profile this revision serves. Required —
 *                      there is no workspace default any more (ADR-037), and
 *                      `lanes link deploy` sets it at rollout.
 *   PORT               injected by Cloud Run. 8080 is its default.
 *
 * And on a Lanes-managed runtime only, three more. Setting the first is what
 * mounts the control surface; absent, this container serves exactly what a
 * self-hosted one serves.
 *
 *   LANES_CONTROL_PUBLIC_KEY  the API's signing key, SPKI PEM. Pinned rather
 *                      than discovered: a runtime that fetched its own trust
 *                      anchor could be told to trust something else.
 *   LANES_CONTROL_ISSUER      who may have signed. Carries the environment.
 *   LANES_CONTROL_AUDIENCE    this service's own URL, for the same reason —
 *                      ADR-072, so a stage assertion is not a prod one.
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

// In this container's own voice, not the CLI's. A revision serves one primary
// profile — it decides the token that opens the endpoint — and nothing here can
// pick one. `lanes link deploy` sets the variable at rollout, in the same
// `gcloud run deploy` as the image, so the two never disagree; a container
// started by hand has to be told. Refusing here beats a CLI-shaped "pass
// --profile" reaching a log where there is no command line to pass it on.
if (!env['LANES_LINK_PROFILE']) {
  process.stderr.write(
    'LANES_LINK_PROFILE is not set on this service. A deployed revision serves one\n' +
      'primary profile and must be told which. `lanes link deploy` sets it at rollout;\n' +
      'if this container was started by hand, pass -e LANES_LINK_PROFILE=<name>.\n',
  );
  process.exit(1);
}

const log = (message: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
};

// Imported only when it is configured, and that is not a style choice.
// `lanes link deploy` submits the *installed package* as the build source
// (`installRoot` in `deployments/gcp/driver.ts`), and package.json's `files`
// excludes `src/control/**` — it is Lanes-only code and has no business in
// every CLI user's node_modules. A static import here would therefore resolve
// in this repository and fail at startup in every self-hosted container, which
// is the worst place to find out.
//
// The env var is the switch, so testing it before the import is the same
// condition `controlDepsFrom` applies, stated once more where the module has to
// be absent. `src/control/boot.test.ts` owns the rest of the behaviour.
//
// Before the bind either way, so a misconfigured key fails the revision rather
// than leaving it healthy and refusing every control call with the same "no" a
// forged assertion gets.
let control;
if (env['LANES_CONTROL_PUBLIC_KEY']) {
  try {
    const { controlDepsFrom } = await import('#control/boot.ts');
    control = await controlDepsFrom(env);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}

if (control) log(`control surface on for workspace ${control.workspace}`);

try {
  const endpoint = await startEndpoint({
    ...(control ? { control } : {}),
    flags: {
      ...(env['LANES_LINK_PROFILE'] ? { profile: env['LANES_LINK_PROFILE'] } : {}),
      ...(env['LANES_LINK_TARGET'] ? { target: env['LANES_LINK_TARGET'] } : {}),
      quiet: true,
    },
    port,
    host,
    // Nothing about tokens here any more (ADR-068): a deployed instance neither
    // mints one nor needs one to boot. A client discovers the
    // protected-resource document from the 401 and signs its owner in.
    // Stdout is where Cloud Run collects logs, and a rejected credential on a
    // public URL is the event this exists for.
    log: streamLogger((line) => process.stdout.write(`${line}\n`)),
    reporter: {
      reconciled({ profile, plan }) {
        // Reconcile output is the record of what a deploy changed, and it is
        // the only place that record exists — the config it applied is baked
        // into an image that will be replaced.
        log(`reconciled ${profile}\n${plan}`);
      },
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
