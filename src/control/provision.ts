import { SUPPORTED_CONTRACT, WORKSPACE_FILE, workspaceFiles, writeWorkspaceFile } from '#profile';
import { MANAGED_TARGET } from './workspace.ts';

/**
 * A managed workspace brings itself into existence on first use.
 *
 * **There is no Enable button, and that is the requirement rather than an
 * omission.** A Lanes workspace *is* its Lanes Link workspace (ADR-071), so
 * asking somebody to create the thing they already have is a step with nothing
 * behind it. Selecting managed in the dashboard, or naming one from an agent, is
 * what makes it real.
 *
 * What was there before this: nothing. No route, no command and no code path
 * anywhere wrote `workspaces.yaml` for a `lanes://` root, so the first
 * `POST /v1/profiles` against a hosted workspace failed on a registry with no
 * `managed` target in it — a workspace that could be addressed, read as empty,
 * and never written to.
 *
 * **Idempotent, and safe to race.** Two calls arriving together both see no
 * file and both write; they write the same bytes, so the loser of the race
 * overwrites with an identical document. Worth stating because the alternative
 * — a read-modify-write, or a lock — would be buying protection against a
 * collision that cannot corrupt anything.
 */

/**
 * Where a managed workspace's credentials live.
 *
 * Secret Manager with a namespace per workspace, which is what
 * `target-managed.test.ts` already pins and what `encodeRef` was given a
 * namespace for: every tenant stores `tokens/tok1`, and without the prefix the
 * second write adds a version to the first tenant's secret and both read one
 * refresh token.
 *
 * The project comes from the environment because it is Lanes', not the
 * customer's, and it is the one field a local run has no answer for. Without
 * one the workspace keeps its credentials as an encrypted document in its own
 * storage instead, sealed under a key derived for that workspace — which is
 * what makes a hosted workspace fully usable with no Google Cloud project
 * anywhere, and is what a local end-to-end run needs.
 */
const SECRET_PROJECT = 'LANES_RUNTIME_SECRET_PROJECT';

function skeleton(workspace: string, project: string | undefined): string {
  // With a project, Secret Manager namespaced per workspace. Without one, an
  // encrypted document in the workspace's own storage — which is what a local
  // run has, and the reason the first version of this file wrote an unusable
  // registry: it named `gcp-secret-manager` unconditionally, so opening a
  // runtime refused with "credentials.project is required" the moment anything
  // beyond configuration was asked for.
  const credentials = project
    ? `{ adapter: gcp-secret-manager, project: ${project}, namespace: ${workspace} }`
    : '{ adapter: blob }';

  // Written as text rather than serialised from an object, so the comments
  // survive. Somebody will read this file while working out what Lanes holds
  // for them, and a bare three keys answer none of the questions they arrive
  // with. Same reason `newWorkspaceTemplate` is a string.
  return `# Lanes Link workspace, hosted by Lanes
#
# Written by Lanes when this workspace was first used. There was no step you
# skipped: a Lanes workspace is its Lanes Link workspace, so there is nothing to
# enable and nothing to create.
#
# "storage: { adapter: lanes }" means the bytes live with Lanes and are read
# through the API, which checks that the caller is a member of this workspace
# before answering. That is also where the plan's storage limit is counted, so
# every byte this workspace holds passes one place.
#
# "credentials" is where the accounts you connect keep their tokens, and
# "vault" is where your own secrets go. Secret Manager namespaced per workspace
# where Lanes runs one, otherwise an encrypted document in this workspace's own
# storage. Either way each key is derived for this workspace alone, so one
# workspace's document cannot be opened with another's key.
#
# Neither may be "file": a workspace that is not on a disk has no path to put
# one at, and the default is "file", which is why both are written here.
#
# "lanes_workspace" binds this to the Lanes workspace whose membership list
# decides who may be put on a profile (ADR-060). Without it the workspace can
# only delegate to whoever is signed in — which on a laptop is you and in a
# container is nobody, so a profile created here listed nobody at all.
#
# The target is called "managed" and the name is not yours to change: every
# control call resolves it by that name, so renaming it here stops this
# workspace answering. \`lanes link workspace rename\` refuses it for that reason.
contract: ${SUPPORTED_CONTRACT}
default_workspace: ${MANAGED_TARGET}
workspaces:
  ${MANAGED_TARGET}:
    lanes_workspace: ${workspace}
    credentials: ${credentials}
    storage: { adapter: lanes, workspace: ${workspace} }
    vault: { adapter: blob }
`;
}

/**
 * Write the registry if this workspace has none. Returns whether it did.
 *
 * The check is a `has` rather than a read: the document is only interesting
 * when it is missing, and a workspace that already has one is the overwhelming
 * common case — every call after the first.
 */
export async function ensureManagedWorkspace(
  root: string,
  workspace: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const files = workspaceFiles(root);
  if (await files.has(WORKSPACE_FILE)) return false;

  await writeWorkspaceFile(files, WORKSPACE_FILE, skeleton(workspace, env[SECRET_PROJECT]));
  return true;
}
