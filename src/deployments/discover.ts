import { readWorkspaceFile, workspaceFiles, WORKSPACE_FILE } from '#profile';
import { captureGcloud } from './gcp/gcloud.ts';

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
export async function discoverDeployments(
  onProgress?: (project: string) => void,
): Promise<Candidate[]> {
  const projects = await captureGcloud(['projects', 'list', '--format', 'value(projectId)']);
  if (!projects.ok) return [];

  const found: Candidate[] = [];

  for (const project of projects.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    onProgress?.(project);

    const services = await captureGcloud([
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

      found.push({ project, region, service, workspace: await workspaceBeside(project) });
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
async function workspaceBeside(project: string): Promise<string | undefined> {
  if (await holdsWorkspace(`gs://${project}`)) return `gs://${project}`;

  const buckets = await captureGcloud([
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

/** A bucket is a workspace when it has the file that says so. Never throws. */
export async function holdsWorkspace(url: string): Promise<boolean> {
  try {
    return (await readWorkspaceFile(workspaceFiles(url), WORKSPACE_FILE)) !== null;
  } catch {
    return false;
  }
}
