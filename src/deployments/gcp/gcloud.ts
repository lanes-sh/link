import { ConfigError, type DeployConfig } from '#profile';
import type { CommandResult } from '../driver.ts';

/**
 * Shelling out to `gcloud`.
 *
 * `lanes link deploy` is a thin wrapper, not a deployment engine (`docs/detailed/init.md`), and
 * the thinnest correct wrapper drives the tool the operator already has
 * authenticated. Reimplementing Cloud Build and the Cloud Run Admin API over
 * REST would mean owning an OAuth flow, a long-running-operation poller, and a
 * revision spec — for a command whose entire job is "build this, roll that".
 *
 * The commands are constructed as argv arrays and never as shell strings, so a
 * project or service name cannot become an argument to something else.
 */

export function gcloudPath(): string | null {
  return Bun.which('gcloud');
}

/**
 * Run a `gcloud` invocation, streaming its output to the terminal.
 *
 * Streamed rather than captured because a build takes minutes and silence for
 * the duration is indistinguishable from a hang.
 *
 * stderr is streamed *and* kept. It used to be inherited outright, which meant
 * a failed step reached the caller as a bare exit code — and "should this be
 * retried" is a question about the message, not the code. A freshly enabled API
 * and a genuinely missing permission both exit 1 and say different things.
 *
 * Only the tail is kept. A build streams its entire log here, and no amount of
 * it beyond the end explains an exit code.
 */
const KEPT_STDERR = 8192;

export async function runGcloud(argv: readonly string[]): Promise<CommandResult> {
  const gcloud = gcloudPath();
  if (!gcloud) {
    return {
      ok: false,
      stdout: '',
      stderr:
        'gcloud is not on your PATH. Install the Google Cloud CLI and run `gcloud auth login`.',
    };
  }

  const child = Bun.spawn([gcloud, ...argv], { stdout: 'inherit', stderr: 'pipe' });

  let captured = '';
  const decoder = new TextDecoder();
  const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    // Written through as it arrives, so a long build reads exactly as it did
    // when this was inherited.
    const text = decoder.decode(value, { stream: true });
    process.stderr.write(text);
    captured = (captured + text).slice(-KEPT_STDERR);
  }

  const code = await child.exited;
  return { ok: code === 0, stdout: '', stderr: captured };
}

/** Run a `gcloud` invocation for its output, without printing it. */
export async function captureGcloud(argv: readonly string[]): Promise<CommandResult> {
  const gcloud = gcloudPath();
  if (!gcloud) {
    return { ok: false, stdout: '', stderr: 'gcloud is not on your PATH.' };
  }

  const child = Bun.spawn([gcloud, ...argv], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * A deploy block that has the field Cloud Run cannot do without.
 *
 * `project` is optional in the schema because it means nothing to a platform
 * without projects, on the same reasoning as `credentials.project` — so the
 * driver that needs it is the thing that refuses without it, and says which
 * platform is asking.
 */
export interface CloudRunTarget extends DeployConfig {
  readonly project: string;
}

export function requireProject(deploy: DeployConfig, target: string): CloudRunTarget {
  if (!deploy.project) {
    throw new ConfigError(
      `targets.${target}.deploy.project is required for the cloudrun platform — ` +
        'a Cloud Run service is addressed by project, region, and name.',
    );
  }
  return { ...deploy, project: deploy.project };
}

/**
 * The public URL Cloud Run assigned this service, or null if it has none yet.
 *
 * The URL is not derivable from the service name — Cloud Run mixes in a
 * project-specific hash — so it has to be asked for rather than constructed.
 */
export async function serviceUrl(target: CloudRunTarget): Promise<string | null> {
  const result = await captureGcloud([
    'run',
    'services',
    'describe',
    target.service,
    '--project',
    target.project,
    '--region',
    target.region,
    '--format',
    'value(status.url)',
  ]);

  return result.ok && result.stdout ? result.stdout : null;
}

/** The project `gcloud` is currently pointed at, if any — a survey default. */
export async function activeProject(): Promise<string | null> {
  const result = await captureGcloud(['config', 'get-value', 'project']);
  const value = result.stdout.trim();
  return result.ok && value && value !== '(unset)' ? value : null;
}

/**
 * Whether a project id is already somebody's.
 *
 * Asked so the survey knows whether it is naming an existing project or one it
 * has to create — which decides whether it needs a billing account at all.
 * A project id that exists but belongs to someone else answers the same as one
 * of yours, which is the right answer here: either way this deploy will not be
 * creating it.
 */
export async function projectExists(project: string): Promise<boolean> {
  const result = await captureGcloud(['projects', 'describe', project, '--format', 'value(projectId)']);
  return result.ok && result.stdout.trim() === project;
}

/**
 * Billing accounts this login can attach a project to.
 *
 * Only open ones: a closed account lists, links, and then fails every API
 * enable behind it with a message about the API rather than about billing.
 */
export async function openBillingAccounts(): Promise<{ id: string; name: string }[]> {
  const result = await captureGcloud([
    'billing',
    'accounts',
    'list',
    '--filter',
    'open=true',
    '--format',
    'value(name,displayName)',
  ]);
  if (!result.ok) return [];

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = '', ...rest] = line.split(/\s+/);
      return { id: id.replace(/^billingAccounts\//, ''), name: rest.join(' ') || id };
    })
    .filter((account) => account.id.length > 0);
}
