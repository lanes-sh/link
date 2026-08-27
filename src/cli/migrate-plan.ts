import { ConfigError, layout, isRemoteWorkspace, type LegacyTarget, type WorkspaceTarget } from '#profile';
import { deployedWorkspace } from '#deployments/upload.ts';

/**
 * What one contract-1 target block becomes, and where.
 *
 * Apart from `workspace-migrate.ts`, which reads and writes: this is the
 * decision, and it is the half that has been wrong twice. Both times the shape
 * was right and the *perspective* was not — the same `cloud:` block is a pointer
 * seen from a laptop and a declaration seen from inside the bucket, and a
 * migration that cannot tell which end it is on writes `gs://b` pointing at
 * `gs://b`.
 *
 * So the workspace being migrated is an argument to every function here, and the
 * tests drive them directly.
 */

/**
 * Every profile's target blocks, folded into one registry.
 *
 * Two refusals rather than guesses, because both are cases where one target
 * would need two different answers and picking either silently is the class of
 * bug this whole change is about.
 */
export async function hoist(
  legacy: readonly { profile: string; targets: Record<string, LegacyTarget> }[],
  workspaceRoot: string,
): Promise<Record<string, WorkspaceTarget>> {
  const registry: Record<string, WorkspaceTarget> = {};
  const seenFrom: Record<string, string> = {};

  for (const { profile, targets } of legacy) {
    for (const [name, declared] of Object.entries(targets)) {
      const entry = toEntry(name, declared, profile, workspaceRoot);
      if (entry === null) continue;
      const previous = registry[name];

      if (previous === undefined) {
        registry[name] = entry;
        seenFrom[name] = profile;
        continue;
      }

      if (JSON.stringify(previous) !== JSON.stringify(entry)) {
        throw new ConfigError(
          `Profiles "${seenFrom[name]}" and "${profile}" both declare target "${name}", and they ` +
            `do not agree.\n` +
            `  A target is declared once by the workspace it lives in (ADR-052), so one of these\n` +
            `  has to win and this cannot pick.\n\n` +
            `    ${seenFrom[name]}: ${summarise(previous)}\n` +
            `    ${profile}: ${summarise(entry)}\n\n` +
            `  Edit one of them to match the other, then run this again.`,
        );
      }
    }
  }

  return registry;
}

/**
 * One contract-1 target block as a registry entry.
 *
 * A block whose storage names a bucket becomes a pointer: that bucket is a
 * workspace, it holds the profiles served there, and under ADR-052 it is the
 * thing that declares the target. The adapters are not copied into the pointer —
 * they travel to the bucket on the next `deploy`, which is the only command that
 * can write there and roll an image that understands what it wrote.
 *
 * Per-profile paths are dropped when they are the layout defaults, which is the
 * ordinary case: `./data/<profile>` and `./data/<profile>/credentials.enc` are
 * exactly what `layout.ts` derives, so a workspace-level target that omits them
 * addresses the same bytes. A genuinely custom path cannot be hoisted — one
 * target cannot hold a different path per profile — and is refused by name.
 */
export function toEntry(
  name: string,
  declared: LegacyTarget,
  profile: string,
  workspaceRoot: string,
): WorkspaceTarget | null {
  const remote = deployedWorkspace(declared);

  // **A target whose bucket is the workspace being migrated declares itself.**
  //
  // Migrating happens on both ends, and the second one is inside the bucket: the
  // profile there carries the same `cloud` block, and deriving a pointer from it
  // produces `gs://b` pointing at `gs://b`. That is a loop, and `openTarget`
  // refuses it — which made `deploy` unable to run against the bucket it had
  // just migrated, on the one command the refusal names as the fix.
  if (remote && remote !== workspaceRoot) return { workspace: remote };

  // **A filesystem target is dropped from a remote workspace.**
  //
  // The bucket's copy of a profile was uploaded from a laptop, so it carries
  // that laptop's `local:` block — paths under `./data/` that address a disk the
  // endpoint has never seen. Hoisting it would leave the bucket declaring a
  // target it can never open, and `workspacePath` refuses that combination the
  // moment anything tries.
  //
  // Nothing is lost: the machine that owns `local` has its own copy, and that is
  // the one that was ever real.
  if (isRemoteWorkspace(workspaceRoot) && declared.storage.adapter === 'filesystem') return null;

  const storagePath = declared.storage.path;
  const credentialsPath = declared.credentials.path;

  const defaultStorage = `./${layout.blobs(profile)}`;
  const defaultCredentials = `./${layout.credentials(profile)}`;

  refuseCustomPath(name, profile, workspaceRoot, 'storage.path', storagePath, defaultStorage);
  refuseCustomPath(
    name,
    profile,
    workspaceRoot,
    'credentials.path',
    credentialsPath,
    defaultCredentials,
  );

  const { path: _storage, ...storage } = declared.storage;
  const { path: _credentials, ...credentials } = declared.credentials;

  return {
    credentials,
    storage,
    ...(declared.audit ? { audit: declared.audit } : {}),
    ...(declared.vault ? { vault: declared.vault } : {}),
    ...(declared.deploy ? { deploy: declared.deploy } : {}),
  };
}

function refuseCustomPath(
  target: string,
  profile: string,
  workspaceRoot: string,
  field: string,
  value: string | undefined,
  expected: string,
): void {
  if (value === undefined) return;
  // Both spellings of the same directory: `./data/personal` and `data/personal`
  // resolve identically and the template has written each at different times.
  if (value === expected || value === expected.replace(/^\.\//, '')) return;

  throw new ConfigError(
    `Profile "${profile}" declares target "${target}" with a custom ${field}:\n` +
      `    ${value}\n` +
      `  A target is declared once for the whole workspace now (ADR-052), so it cannot hold a\n` +
      `  different path per profile. The default it would get is ${expected}.\n\n` +
      `  Move the data there and delete the line, or keep this profile in a workspace of its\n` +
      `  own: LANES_LINK_HOME=${workspaceRoot}/<somewhere> lanes link profile add ${profile} --target ${target}`,
  );
}

export function summarise(entry: WorkspaceTarget): string {
  if (entry.workspace !== undefined) return `points at ${entry.workspace}`;
  const parts = [entry.credentials?.adapter, entry.storage?.adapter].filter(Boolean);
  return `${parts.join(' + ')}${entry.deploy ? `, deploys ${entry.deploy.service}` : ''}`;
}
