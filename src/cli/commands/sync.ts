import { ConfigError, readRegistry, recordTarget, resolveWorkspaceRoot } from '#profile';
import { discoverDeployments, holdsWorkspace } from '#deployments/discover.ts';
import { emit, heading, ok, print, style, waiting } from '../output.ts';
import { confirm, isInteractive } from '../prompt.ts';
import type { GlobalFlags } from '../runtime.ts';

/**
 * `lanes link sync targets` — adopt a deployment this workspace has lost track of.
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

export interface SyncFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly from?: string | undefined;
  readonly discover?: boolean | undefined;
  readonly prefer?: string | undefined;
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
): Promise<{ workspace: string; how: string }> {
  if (flags.from) {
    if (!(await holdsWorkspace(flags.from))) {
      throw new ConfigError(
        `${flags.from} does not hold a workspace — no lanes-link.yaml in it.\n` +
          '  Check the bucket name, or run with --discover to search for one.',
      );
    }
    return { workspace: flags.from.replace(/\/$/, ''), how: '--from' };
  }

  const entry = (await readRegistry(root))[target];
  if (entry?.at) return { workspace: entry.at, how: 'already recorded' };

  if (flags.discover !== true) {
    throw new ConfigError(
      `Nothing here says where "${target}" lives.\n` +
        '  No pointer to it in lanes-link.yaml, and nothing else records one.\n\n' +
        '  If you know the bucket:  lanes link sync targets --target ' +
        `${target} --from gs://<bucket>\n` +
        `  If you do not:           lanes link sync targets --workspace ${target} --discover`,
    );
  }

  const candidates = (
    await waiting('searching your projects for a deployment', () => discoverDeployments())
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
        `  lanes link sync targets --workspace ${target} --from ${first.workspace}`,
    );
  }

  if (!(await confirm(`  Point "${target}" at ${first.workspace}?`))) {
    throw new ConfigError('Nothing was read or written.');
  }

  return { workspace: first.workspace!, how: 'discovered' };
}

export async function syncTargets(flags: SyncFlags): Promise<void> {
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

  const { workspace, how } = await locateRemote(root, target, flags);

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
