import { ConfigError, readRegistry, recordTarget, resolveWorkspaceRoot, WORKSPACE_FILE } from '#profile';
import { discoverDeployments, probeWorkspace } from '#deployments/discover.ts';
import type { Candidate, WorkspaceProbe } from '#deployments/discover.ts';
import { join } from 'node:path';
import { emit, heading, ok, print, style, waiting } from '../output.ts';
import { confirm, isInteractive } from '../prompt.ts';
import type { GlobalFlags } from '../runtime.ts';

/**
 * `lanes link sync workspaces` — adopt a deployment this workspace has lost track of.
 *
 * **This used to reconcile two copies of every profile, and there is only one
 * now.** A deploy left the workspace holding one copy and the bucket another,
 * they were meant to agree, and when they stopped there was no way to say which
 * side had lost something. The reported case, twice: a local profile was
 * rewritten and lost its cloud target, `auth.authorization`, and six
 * connections, while the bucket still held every one of them and the service
 * went on answering.
 *
 * ADR-052 removed the second copy rather than the disagreement. A profile lives
 * in exactly one target's workspace, so the diff engine this command was built
 * around — `sync-apply.ts`, `sync.ts`, `--prefer local|remote` — had nothing
 * left to compare and is gone with contract 1.
 *
 * What survives is the half that was never about merging: **finding a
 * deployment the local registry has no pointer to**, and writing that pointer.
 * A new machine, a reinstall, a workspace file restored from something older —
 * the endpoint is still serving, and what went missing is the line saying where
 * it lives. That is one write, and it cannot lose anything, because the bucket
 * is authoritative for everything except its own address.
 *
 * `--prefer` is gone and is refused by name rather than ignored: it decided
 * which side won a merge, and someone typing it is asking for behaviour this
 * command no longer has.
 */

/**
 * What the command reaches the world with. Injected in tests; every field is
 * the real thing when absent.
 */
export interface SyncDeps {
  readonly probe?: ((url: string) => Promise<WorkspaceProbe>) | undefined;
  readonly discover?: (() => Promise<Candidate[]>) | undefined;
}

export interface SyncFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly from?: string | undefined;
  readonly discover?: boolean | undefined;
  readonly prefer?: string | undefined;
}

/**
 * Refuse a bucket that cannot serve as one, saying which of four things happened.
 *
 * Four, because the probe distinguishes them and a reader acts on each
 * differently: an empty bucket is a typo, an unreadable one is a login, and one
 * on the old filename is a migration. The version of this that answered a single
 * boolean told all three to check the bucket name.
 */
async function assertHoldsWorkspace(from: string, target: string, deps: SyncDeps): Promise<void> {
  const probe = await (deps.probe ? deps.probe(from) : probeWorkspace(from));
  if (probe.kind === 'workspace') return;

  if (probe.kind === 'unreadable') {
    throw new ConfigError(
      `${from} could not be read, so whether it holds a workspace is not known.\n` +
        `  ${probe.reason}\n` +
        // Only where credentials are the cause: --discover runs the same chain,
        // so offering it there is offering something that cannot get further.
        (probe.credentials
          ? '  --discover reads the same credentials, so it would not get further.'
          : ''),
    );
  }

  if (probe.kind === 'legacy') {
    throw new ConfigError(
      `${from} holds a workspace under the old name, lanes-link.yaml.\n` +
        '  It is a workspace, but one from before the registry was renamed, and\n' +
        '  reading it here would report that it declares nothing at all.\n' +
        `    lanes link deploy --workspace ${target}   rewrites it in the current shape`,
    );
  }

  throw new ConfigError(
    `Nothing at ${from.replace(/\/$/, '')}/${WORKSPACE_FILE}, so that bucket declares no workspace.\n` +
      '  A bucket that does not exist reads exactly the same way, so check the name first.\n' +
      `  If you do not know it:  lanes link sync workspaces --workspace ${target} --discover`,
  );
}

/**
 * Where the target's workspace is, tried cheapest first.
 *
 * The order is the point. An existing pointer answers instantly and is right
 * whenever anything is; `--from` is for when the operator knows and the
 * workspace does not; and discovery is the one that works from nothing, at the
 * cost of a `gcloud` call per project.
 */
async function locateRemote(
  root: string,
  target: string,
  flags: SyncFlags,
  deps: SyncDeps,
): Promise<{ workspace: string; how: string }> {
  if (flags.from) {
    await assertHoldsWorkspace(flags.from, target, deps);
    return { workspace: flags.from.replace(/\/$/, ''), how: '--from' };
  }

  const registry = await readRegistry(root);
  const entry = registry[target];
  if (entry?.at) return { workspace: entry.at, how: 'already recorded' };

  // Declared here rather than pointed at: `at` is set only on a pointer, so a
  // root that holds the target's own declaration used to fall through to
  // "nothing says where it lives" while standing inside it. Nothing to adopt is
  // a different answer from nowhere to look.
  if (entry !== undefined) {
    throw new ConfigError(
      `${root} declares "${target}" itself, so there is nothing to adopt —\n` +
        '  this is already its workspace, and a pointer would only point at itself.\n' +
        `    lanes link status --workspace ${target}`,
    );
  }

  if (flags.discover !== true) {
    throw new ConfigError(
      `Nothing here says where "${target}" lives.\n` +
        `  ${join(root, WORKSPACE_FILE)} holds no pointer to it, and nothing else on\n` +
        '  this machine records one.\n\n' +
        `  If you know the bucket:  lanes link sync workspaces --workspace ${target} --from gs://<bucket>\n` +
        `  If you do not:           lanes link sync workspaces --workspace ${target} --discover\n\n` +
        '  Naming it once is enough: this writes the pointer, and no later command asks again.',
    );
  }

  const candidates = (
    await waiting('searching your projects for a deployment', () =>
      deps.discover ? deps.discover() : discoverDeployments(),
    )
  ).filter((candidate) => candidate.workspace !== undefined);

  if (candidates.length === 0) {
    throw new ConfigError(
      'Found no deployment holding a workspace in any project this login can see.\n' +
        '  Check you are logged in as the right account: gcloud auth list',
    );
  }

  print('');
  for (const candidate of candidates) {
    print(`  ${style.bold(candidate.service)}  ${candidate.region}  ${candidate.project}`);
    print(style.dim(`    workspace ${candidate.workspace}`));
  }

  // One is offered rather than chosen: adopting the wrong deployment would point
  // this workspace at a stranger's accounts.
  const first = candidates[0]!;
  if (candidates.length > 1 || !isInteractive()) {
    throw new ConfigError(
      `Found ${candidates.length} deployment(s). Name the one you mean:\n` +
        `  lanes link sync workspaces --workspace ${target} --from ${first.workspace}`,
    );
  }

  if (!(await confirm(`Point "${target}" at ${first.workspace}?`))) {
    throw new ConfigError('Nothing was read or written.');
  }

  return { workspace: first.workspace!, how: 'discovered' };
}

export async function syncTargets(flags: SyncFlags, deps: SyncDeps = {}): Promise<void> {
  const target = flags.target!;
  const root = resolveWorkspaceRoot();

  if (flags.prefer !== undefined) {
    throw new ConfigError(
      '--prefer decided which of two copies of a profile won a merge, and there is\n' +
        'only one copy now: the one in the target\'s own workspace (ADR-052).\n' +
        '  This command adopts a deployment, and adopting cannot overwrite anything.\n' +
        '  Drop the flag and run it again.',
    );
  }

  const { workspace, how } = await locateRemote(root, target, flags, deps);

  // What is actually there, so an adoption cannot point at an empty bucket and
  // report success. This is the one read the command makes, and it is also the
  // check: a workspace that declares this target is a workspace that can serve
  // it.
  const remoteRegistry = await readRegistry(workspace);
  const declaresIt = remoteRegistry[target] !== undefined;
  const existing = (await readRegistry(root))[target];
  const already = existing?.at === workspace;

  const payload = { workspace: root, remote: workspace, target, how, declaresIt, applied: false };

  const render = (): void => {
    print(style.dim(`workspace ${style.bold(root)}  target ${style.bold(target)}`));
    print(style.dim(`remote    ${workspace}  (${how})`));
    print('');

    if (!declaresIt) {
      const there = Object.keys(remoteRegistry).sort().join(', ') || 'none';
      print(
        style.yellow(
          `${workspace} does not declare a target called "${target}" (it declares: ${there}).`,
        ),
      );
      print(
        style.dim(
          '  Adopting it would write a pointer to a workspace that cannot answer for\n' +
            '  this target. Check the name, or deploy it there first.',
        ),
      );
      return;
    }

    if (already) {
      print(ok('already pointed there — nothing to change'));
      return;
    }

    heading('Would write');
    print(`  workspaces.${target}.at: ${workspace}`);
    print(style.dim('  The bucket keeps everything else; this records where it is.'));
  };

  if (!declaresIt) {
    render();
    throw new ConfigError(`"${target}" is not declared at ${workspace}.`);
  }

  if (flags.dryRun || already) {
    render();
    if (flags.dryRun) print(style.dim('  --dry-run: nothing was written.'));
    return emit(flags.json, payload, () => {});
  }

  render();

  // Only the pointer. Everything that describes the target — its adapters, its
  // deploy block, whose token opens it — is declared where it lives, and reading
  // it from there is what makes this safe to run on a workspace that has lost
  // its own copy of anything.
  await recordTarget(root, target, { at: workspace });

  print('');
  print(ok(`"${target}" now points at ${workspace}`));
  print(style.dim(`  lanes link status --workspace ${target}   reads it from there`));

  return emit(flags.json, { ...payload, applied: true }, () => {});
}
