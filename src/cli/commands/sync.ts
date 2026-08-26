import {
  ConfigError,
  findDeployment,
  loadWorkspaceProfiles,
  recordDeployment,
  resolveWorkspaceRoot,
} from '#profile';
import {
  applyBlobs,
  applyPulls,
  applyPushes,
  planBlobs,
  planProfile,
  profilesInEither,
  resolved,
  type Prefer,
  type ProfileSync,
} from '#deployments/sync-apply.ts';
import { conflictsIn, type Change } from '#deployments/sync.ts';
import { deployedWorkspace } from '#deployments/upload.ts';
import { discoverDeployments, holdsWorkspace } from '#deployments/discover.ts';
import { emit, heading, ok, print, style, waiting, warn } from '../output.ts';
import { confirm, isInteractive } from '../prompt.ts';
import type { GlobalFlags } from '../runtime.ts';

/**
 * `lanes link sync targets` — the workspace and a target's copy of it, reconciled.
 *
 * A deploy leaves two copies of every profile: the one in the workspace and the
 * one in the bucket the endpoint reads. They are meant to agree, and when they
 * stop there was no way to find out, let alone to say which side had lost
 * something. The reported case: a local profile was rewritten and lost its
 * cloud target, `auth.authorization`, and six connections, while the bucket
 * still held every one of them and the service went on answering.
 *
 * Union, and refuse where a union is impossible (ADR-044). Nothing here
 * overwrites a value that exists on both sides — that is `--prefer`, asked for
 * explicitly, because silently choosing one copy over the other is the failure
 * this command was written in response to.
 */

export interface SyncFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly from?: string | undefined;
  readonly discover?: boolean | undefined;
  readonly prefer?: string | undefined;
}

function parsePrefer(value: string | undefined): Prefer | undefined {
  if (value === undefined) return undefined;
  if (value !== 'local' && value !== 'remote') {
    throw new ConfigError(`--prefer must be "local" or "remote", not "${value}"`);
  }
  return value;
}

/**
 * Where the target's copy lives, tried cheapest first.
 *
 * The order is the point. A declared target answers instantly and is right
 * whenever anything is; the index answers instantly and is right when the
 * declaration is what went missing; `--from` is for when the operator knows and
 * the workspace does not; and discovery is the one that works from nothing, at
 * the cost of a `gcloud` call per project.
 */
async function locateRemote(
  root: string,
  target: string,
  flags: SyncFlags,
): Promise<{ workspace: string; how: string }> {
  if (flags.from) {
    if (!(await holdsWorkspace(flags.from))) {
      throw new ConfigError(
        `${flags.from} does not hold a workspace — no ${'lanes-link.yaml'} in it.\n` +
          '  Check the bucket name, or run with --discover to search for one.',
      );
    }
    return { workspace: flags.from.replace(/\/$/, ''), how: '--from' };
  }

  for (const entry of (await loadWorkspaceProfiles(root)).loaded) {
    const declared = entry.config.targets[target];
    const workspace = declared ? deployedWorkspace(declared) : undefined;
    if (workspace) return { workspace, how: `declared by ${entry.profile}` };
  }

  const recorded = await findDeployment(root, target);
  if (recorded) return { workspace: recorded.workspace, how: 'recorded by a previous deploy' };

  if (flags.discover !== true) {
    throw new ConfigError(
      `Nothing here says where "${target}" lives.\n` +
        '  No profile declares it, and no deploy recorded it in lanes-link.yaml.\n\n' +
        '  If you know the bucket:  lanes link sync targets --target ' +
        `${target} --from gs://<bucket>\n` +
        `  If you do not:           lanes link sync targets --target ${target} --discover`,
    );
  }

  const candidates = (
    await waiting('searching your projects for a deployment', () =>
      discoverDeployments(),
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

  // One is offered rather than chosen: adopting the wrong deployment would
  // merge a stranger's config into this workspace.
  const first = candidates[0]!;
  if (candidates.length > 1 || !isInteractive()) {
    throw new ConfigError(
      `Found ${candidates.length} deployment(s). Name the one you mean:\n` +
        `  lanes link sync targets --target ${target} --from ${first.workspace}`,
    );
  }

  if (!(await confirm(`  Sync "${target}" against ${first.workspace}?`))) {
    throw new ConfigError('Nothing was read or written.');
  }

  return { workspace: first.workspace!, how: 'discovered' };
}

const arrow = (direction: Change['direction']): string =>
  direction === 'pull' ? style.green('←') : direction === 'push' ? style.cyan('→') : style.yellow('!');

const describe = (change: Change): string => {
  const path = change.path.length === 0 ? 'the whole profile' : change.path.join('.');
  if (change.direction === 'pull') return `${path}  ${style.dim('missing locally')}`;
  if (change.direction === 'push') return `${path}  ${style.dim('missing remotely')}`;
  return `${path}  ${style.dim(`local ${short(change.local)} ≠ remote ${short(change.remote)}`)}`;
};

const short = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? 'nothing').length > 40 ? `${(text ?? '').slice(0, 37)}…` : (text ?? 'nothing');
};

export async function syncTargets(flags: SyncFlags): Promise<void> {
  const target = flags.target!;
  const prefer = parsePrefer(flags.prefer);
  const root = resolveWorkspaceRoot();

  const { workspace: remote, how } = await locateRemote(root, target, flags);

  const names = flags.profile ? [flags.profile] : await profilesInEither(root, remote);
  const plans: ProfileSync[] = [];
  for (const profile of names) plans.push(await planProfile(root, remote, profile, prefer));

  const blobs = await planBlobs(root, remote);
  const conflicts = [
    ...plans.flatMap((plan) => conflictsIn(plan.changes)),
    ...blobs.filter((blob) => blob.direction === 'conflict'),
  ];

  const payload = {
    workspace: root,
    remote,
    target,
    profiles: plans.map((plan) => ({ profile: plan.profile, changes: plan.changes })),
    blobs,
    conflicts: conflicts.length,
    applied: false,
  };

  const render = (): void => {
    print(style.dim(`workspace ${style.bold(root)}  target ${style.bold(target)}`));
    print(style.dim(`remote    ${remote}  (${how})`));

    let anything = false;
    for (const plan of plans) {
      if (plan.changes.length === 0) continue;
      anything = true;

      heading(plan.profile);
      for (const change of plan.changes) print(`  ${arrow(change.direction)} ${describe(change)}`);
    }

    if (blobs.length > 0) {
      anything = true;
      heading('Skills and manifests');
      for (const blob of blobs) print(`  ${arrow(blob.direction)} ${blob.key}`);
    }

    if (!anything) print(ok('already in step — nothing to copy in either direction'));
  };

  if (conflicts.length > 0 && prefer === undefined) {
    render();
    print('');
    throw new ConfigError(
      `${conflicts.length} conflict(s): both copies hold these, and they disagree.\n` +
        '  Nothing was written. Re-run with --prefer local or --prefer remote,\n' +
        '  or edit one side so they agree.',
    );
  }

  if (flags.dryRun === true) {
    return emit(flags.json, payload, () => {
      render();
      print('');
      print(style.dim('  --dry-run: nothing was written on either side.'));
    });
  }

  if (flags.json !== true) render();

  let pulled = 0;
  let pushed = 0;
  for (const plan of plans) {
    const changes = resolved(plan.changes, prefer);
    pulled += await applyPulls(root, remote, plan.profile, changes);
    if (await applyPushes(root, remote, plan.profile, changes)) pushed += 1;
  }

  const copied = await applyBlobs(
    root,
    remote,
    resolvedBlobs(blobs, prefer),
  );

  // Recorded now that a bucket has been confirmed to hold this target's
  // workspace: the next recovery does not have to discover it again.
  await recordDeployment(root, { target, workspace: remote });

  return emit(flags.json, { ...payload, applied: true, pulled, pushed, copied }, () => {
    print('');
    if (pulled === 0 && pushed === 0 && copied === 0) return;

    print(ok(`${pulled} key(s) pulled, ${pushed} profile(s) pushed, ${copied} file(s) copied`));
    print(style.dim(`  recorded ${remote} in lanes-link.yaml, so this is findable next time`));
    if (pushed > 0) {
      print(style.dim(`  the endpoint re-reads its config on the next call — or run:`));
      print(style.dim(`    lanes link status --target ${target}`));
    }
  });
}

/** A conflicting file follows `--prefer` like a conflicting key does. */
function resolvedBlobs(
  blobs: readonly { key: string; direction: 'pull' | 'push' | 'conflict' }[],
  prefer: Prefer | undefined,
): { key: string; direction: 'pull' | 'push' }[] {
  return blobs.flatMap((blob) => {
    if (blob.direction !== 'conflict') return [{ key: blob.key, direction: blob.direction }];
    if (prefer === undefined) return [];
    return [{ key: blob.key, direction: prefer === 'remote' ? ('pull' as const) : ('push' as const) }];
  });
}
