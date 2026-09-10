import { LEGACY_WORKSPACE_FILE, workspaceFiles, WORKSPACE_FILE } from '#profile';
import type { BlobStore } from '#stores/blobs';
import { GoogleCredentialsError } from './adapters/gcp-secret-manager.ts';
import { captureGcloud } from './gcp/gcloud.ts';
import type { CommandResult } from './driver.ts';

/**
 * Finding a deployment nothing in the workspace mentions any more.
 *
 * The last resort, and the one that works from nothing. A profile that lost its
 * target block and a workspace with no index between them leave no local record
 * that a deployment ever existed — but the deployment is still there, still
 * answering, and still holding the config it was given. Asking the platform is
 * the only way back from that state.
 *
 * Deliberately opt-in. It is a `gcloud` call per project and there may be
 * dozens, so a command that did this on every run would be one nobody waits
 * for. Everything cheaper is tried first.
 */

export interface Candidate {
  readonly project: string;
  readonly region: string;
  readonly service: string;
  /** The bucket holding a workspace, when one was found beside the service. */
  readonly workspace: string | undefined;
}

/**
 * Cloud Run services across every project this login can see.
 *
 * Not filtered by name. A service is a candidate because a bucket beside it
 * holds a workspace, not because of what it is called — the operator may have
 * named it anything, and a name filter would hide exactly the deployment whose
 * naming convention nobody remembers.
 */
export interface DiscoverOptions {
  readonly onProgress?: ((project: string) => void) | undefined;
  /** The gcloud runner. Injected in tests; the real one when absent. */
  readonly gcloud?: ((argv: readonly string[]) => Promise<CommandResult>) | undefined;
}

export async function discoverDeployments(options: DiscoverOptions = {}): Promise<Candidate[]> {
  const run: (argv: readonly string[]) => Promise<CommandResult> = options.gcloud ?? captureGcloud;
  const onProgress = options.onProgress;

  const projects = await run(['projects', 'list', '--format', 'value(projectId)']);
  // Not an empty list. "gcloud is not on your PATH" and "you are not logged in"
  // are both failures to *ask*, and reporting them as an answer produces the
  // sentence this used to end at: no deployment in any project this login can
  // see, about a list nobody obtained.
  if (!projects.ok) {
    throw new Error(
      `Could not list your Google Cloud projects, so there was nowhere to search.\n  ${
        projects.stderr || 'gcloud exited non-zero and said nothing.'
      }`,
    );
  }

  const found: Candidate[] = [];

  for (const project of projects.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    onProgress?.(project);

    const services = await run([
      'run',
      'services',
      'list',
      '--project',
      project,
      '--format',
      'value(metadata.name,metadata.labels."cloud.googleapis.com/location")',
    ]);
    if (!services.ok || !services.stdout) continue;

    for (const line of services.stdout.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      const [service = '', region = ''] = line.split(/\s+/);
      if (!service || !region) continue;

      found.push({ project, region, service, workspace: await workspaceBeside(project, run) });
    }
  }

  return found;
}

/**
 * Whether a project holds a bucket with a workspace in it.
 *
 * The survey names the bucket after the project, so that is checked first and
 * is almost always the answer. Falling back to listing every bucket costs a
 * second call and covers a workspace whose bucket was named by hand.
 */
async function workspaceBeside(
  project: string,
  run: (argv: readonly string[]) => Promise<CommandResult>,
): Promise<string | undefined> {
  if (await holdsWorkspace(`gs://${project}`)) return `gs://${project}`;

  const buckets = await run([
    'storage',
    'buckets',
    'list',
    '--project',
    project,
    '--format',
    'value(name)',
  ]);
  if (!buckets.ok) return undefined;

  for (const name of buckets.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (name === project) continue;
    if (await holdsWorkspace(`gs://${name}`)) return `gs://${name}`;
  }

  return undefined;
}

/**
 * What a bucket turned out to hold, including "could not tell".
 *
 * The fourth case is the one this exists for. `has` already distinguishes
 * absence from failure — a 404 is `false`, everything else throws (`gcs.ts`,
 * "Absence is a value, not an error") — and the old probe collapsed both into
 * one boolean, so a laptop with no credentials was told to check the bucket
 * name. Nothing new is being detected here; a distinction that was always there
 * is being kept.
 */
export type WorkspaceProbe =
  | { readonly kind: 'workspace' }
  | { readonly kind: 'legacy' }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'unreadable';
      /** What the adapter said, which already names the fix for most causes. */
      readonly reason: string;
      /** Whether the cause was credentials, so the caller may offer signing in. */
      readonly credentials: boolean;
    };

export interface ProbeOptions {
  /** The workspace's files. Built from the URL when absent; injected in tests. */
  readonly files?: BlobStore | undefined;
}

/**
 * Ask one named bucket what it holds.
 *
 * Never rejects: every failure is a `kind`, which is what lets `holdsWorkspace`
 * below drop its own `try` and stay a plain boolean for the scan.
 *
 * `has` rather than a read, because the answer is a yes-or-no and `has` is
 * metadata-only — which pays for the second call the legacy branch makes.
 */
export async function probeWorkspace(
  url: string,
  options: ProbeOptions = {},
): Promise<WorkspaceProbe> {
  try {
    // Built in here rather than defaulted in the signature: `workspaceFiles`
    // throws synchronously for a URL naming no bucket, and that should be
    // reported like any other reason rather than rejecting out of the probe.
    const files = options.files ?? workspaceFiles(url);

    if (await files.has(WORKSPACE_FILE)) return { kind: 'workspace' };
    // `readWorkspace` accepts either name, so a bucket restored from something
    // older *is* a workspace — but saying so here would send the caller on to
    // parse a file keyed `targets:` and be told it declares nothing.
    if (await files.has(LEGACY_WORKSPACE_FILE)) return { kind: 'legacy' };

    return { kind: 'absent' };
  } catch (failure) {
    return {
      kind: 'unreadable',
      reason: (failure as Error).message,
      credentials: failure instanceof GoogleCredentialsError,
    };
  }
}

/**
 * A bucket is a workspace when it has the file that says so. Never throws.
 *
 * Deliberately still a boolean, and deliberately still blind to why: its callers
 * sweep every bucket in every project, where one that cannot be read is simply
 * not a candidate and a reason per bucket would be noise. The caller that names
 * a single bucket uses `probeWorkspace`.
 */
export async function holdsWorkspace(url: string, options: ProbeOptions = {}): Promise<boolean> {
  return (await probeWorkspace(url, options)).kind === 'workspace';
}
