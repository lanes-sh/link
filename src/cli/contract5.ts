import {
  CONNECTIONS_FILE,
  layout,
  listProfiles,
  readWorkspaceFile,
  workspaceFiles,
} from '#profile';
import { parseDocument } from 'yaml';
import { ConfigDocument } from './config-edit.ts';
import { openOrCreateConnections } from './config-repair-sweep.ts';
import { ensureRegistryContract } from './config-repair-sweep.ts';

/**
 * Contract 4 to contract 5: the endpoint token becomes a person's.
 *
 * Contract 4 left `auth.token_ref` on every profile, defaulting to the constant
 * `profile/token` out of a credential store that has been one per workspace
 * since contract 3. So "the profile's token" was the workspace's wearing a
 * per-profile name, which is why `profile remove` once deleted the token its
 * siblings were being served by, and why every command whose subject is the
 * endpoint had to name a profile in order to find it. ADR-068 moves it to
 * `tokens:` in `connections.yaml`, one row per token, each naming the Lanes
 * subject it was issued to.
 *
 * **The subject is what this migration cannot invent.** A row exists so a
 * bearer token can resolve through `members:` the way an OAuth token does, and
 * a row with the wrong subject is worse than no row: it is a credential that
 * looks issued and reaches nothing, or reaches somebody else's profiles. So the
 * subject comes from the profiles themselves — the owner-role member of a
 * profile that actually holds the token — and when there is no such member this
 * refuses and says which command fixes it.
 *
 * Three steps, ordered so a crash between any two leaves a workspace that still
 * opens and a rerun that still finishes:
 *
 *   1. The row is written into `connections.yaml`, pointing at the ref the
 *      value is *already* under. Nothing moves in the credential store, which
 *      is what makes this safe to interrupt: the old key and the new row name
 *      the same bytes.
 *   2. `auth.token_ref` is removed from each profile.
 *   3. Each profile is stamped `contract: 5`.
 *
 * **The stamp is last**, for the reason contract 4 records: contract 3 shipped
 * with it first, which left profiles claiming the new contract with every byte
 * at the old path and a rerun that read the stamp and found nothing to do.
 *
 * **The ref is not renamed to `tokens/tok1`.** It would read better and it
 * would mean copying a live credential in a store that may be Secret Manager,
 * then deleting the original — two writes and a window where a deployed
 * revision reads neither. A row may name any ref; `profile/token` is a
 * perfectly good one, and the one thing that must not break here is an endpoint
 * that was working before the upgrade.
 */

export interface Contract5Migration {
  readonly workspaceRoot: string;
  readonly profiles: readonly string[];
  readonly changes: readonly string[];
  /** Written into `tokens:`, as `id → subject`. Empty when there was no token. */
  readonly issued: readonly { readonly id: string; readonly subject: string }[];
  readonly alreadyCurrent: boolean;
}

interface RawProfile {
  readonly contract?: number;
  readonly auth?: { readonly token_ref?: unknown };
  readonly members?: readonly { readonly subject?: unknown; readonly role?: unknown }[];
}

/** Whether this workspace still holds anything at contract 4. */
export async function needsContract5(workspaceRoot: string): Promise<boolean> {
  for (const profile of await listProfiles(workspaceRoot)) {
    const raw = await readProfile(workspaceRoot, profile);
    if (raw !== null && (raw.contract ?? 0) === 4) return true;
  }
  return false;
}

export async function migrateToContract5(
  workspaceRoot: string,
  options: { apply: boolean; subject?: string } = { apply: true },
): Promise<Contract5Migration> {
  const legacy = new Map<string, RawProfile>();

  for (const profile of await listProfiles(workspaceRoot)) {
    const raw = await readProfile(workspaceRoot, profile);
    if (raw !== null && (raw.contract ?? 0) === 4) legacy.set(profile, raw);
  }

  if (legacy.size === 0) {
    return { workspaceRoot, profiles: [], changes: [], issued: [], alreadyCurrent: true };
  }

  const profiles = [...legacy.keys()];
  const changes: string[] = [];
  const issued: { id: string; subject: string }[] = [];

  // Every distinct ref the profiles held, in the order they are declared. Almost
  // always one — the template's constant — but a profile that overrode
  // `token_ref` had a genuinely separate credential, and dropping it would take
  // a working endpoint down.
  const refs = new Map<string, string[]>();
  for (const [profile, raw] of legacy) {
    const ref = typeof raw.auth?.token_ref === 'string' ? raw.auth.token_ref : 'profile/token';
    refs.set(ref, [...(refs.get(ref) ?? []), profile]);
  }

  if (!options.apply) {
    for (const [ref, holders] of refs) {
      changes.push(`${CONNECTIONS_FILE}: tokens += a row for "${ref}" (${holders.join(', ')})`);
    }
    for (const profile of profiles) changes.push(`${profile}: auth.token_ref removed`);
    return { workspaceRoot, profiles, changes, issued: [], alreadyCurrent: false };
  }

  // **The one thing this cannot guess.** `--subject` from `update`, else the
  // owner-role member of a profile that held the ref. Refusing beats writing a
  // row nobody can use: a token bound to the wrong subject reaches the wrong
  // profiles, and one bound to nobody reaches none while looking issued.
  const document = await openOrCreateConnections(workspaceRoot);
  // Through `toJSON`, not `getIn`. `getIn` hands back YAML nodes, so reading
  // `row.ref` off one is `undefined` — the idempotence check below silently
  // never matched, and a rerun after an interruption wrote the row twice.
  const existing = asRows((document.toJSON() as { tokens?: unknown } | null)?.tokens);
  let next = existing.length + 1;

  for (const [ref, holders] of refs) {
    // Already migrated, which is what an interrupted run looks like from here.
    if (existing.some((row) => row.ref === ref)) continue;

    const subject = options.subject ?? ownerSubject(legacy, holders);
    if (subject === undefined) {
      throw new ContractError(
        `Cannot migrate the endpoint token at "${ref}": a token now names the person it was\n` +
          'issued to (ADR-068), and no profile holding it lists an owner.\n' +
          `  Holding it: ${holders.join(', ')}\n` +
          '  Sign in and say who you are, then run this again:\n' +
          '    lanes auth login\n' +
          `    lanes link profile members add --me --profile ${holders[0]} --workspace <name>`,
      );
    }

    const id = `tok${next++}`;
    document.addTo(['tokens'], { id, subject, ref, label: 'migrated' });
    issued.push({ id, subject });
    changes.push(`${CONNECTIONS_FILE}: tokens += ${id} → ${subject} ("${ref}")`);

    // **Say so when the row reaches nothing.** A subject that no profile lists
    // is a token the endpoint refuses, and the operator's CI would fail with a
    // 401 that reads as a bad credential. It happens on the path a signed-in
    // operator upgrades a workspace whose `members:` is empty — legitimate, and
    // contract 3 only fills that in for workspaces it migrates itself.
    if (!listedAnywhere(legacy, subject)) {
      changes.push(
        `  warning: no profile lists ${subject}, so ${id} reaches nothing until one does — ` +
          'lanes link profile members add --me --profile <name> --workspace <name>',
      );
    }
  }

  // The stamp, for the reason contract 4 gives where it does the same: nothing
  // reads this field — every contract check is on a profile — which is exactly
  // why it goes stale, and a marker that lies is worse than no marker for
  // whoever writes the next migration.
  document.setIn(['contract'], 5);

  await document.save();

  for (const profile of profiles) {
    const config = await ConfigDocument.open(workspaceRoot, profile);
    config.removeIn(['auth', 'token_ref']);
    // Last, and the record that this profile finished.
    config.setIn(['contract'], 5);
    await config.save({ contract: 5 });
    changes.push(`${profile}: auth.token_ref removed, contract 5`);
  }

  // After the profiles, so the registry never claims a contract they have not
  // reached — `isUnmigrated` reads this field and nothing else.
  await ensureRegistryContract(workspaceRoot, 5);

  return { workspaceRoot, profiles, changes, issued, alreadyCurrent: false };
}

/** Raised so `doctor` and `update` can print it rather than a stack. */
export class ContractError extends Error {}

/** Whether any profile being migrated lists this subject as a member. */
function listedAnywhere(legacy: ReadonlyMap<string, RawProfile>, subject: string): boolean {
  for (const raw of legacy.values()) {
    if ((raw.members ?? []).some((member) => member.subject === subject)) return true;
  }
  return false;
}

/**
 * The subject to bind a ref to: an owner of a profile that held it.
 *
 * `owner` rather than any member, because `owner` is who may edit the member
 * list (ADR-060) and is therefore the one role that cannot have been delegated
 * a narrower reach than the token used to have. Falls back to any member, since
 * a profile with members and no owner still has somebody this belonged to, and
 * a workspace migrated by contract 3 while signed out has neither.
 */
function ownerSubject(
  legacy: ReadonlyMap<string, RawProfile>,
  holders: readonly string[],
): string | undefined {
  for (const role of ['owner', undefined]) {
    for (const profile of holders) {
      for (const member of legacy.get(profile)?.members ?? []) {
        if (typeof member.subject !== 'string') continue;
        if (role === undefined || member.role === role) return member.subject;
      }
    }
  }
  return undefined;
}

function asRows(value: unknown): readonly { ref?: string }[] {
  return Array.isArray(value) ? (value as { ref?: string }[]) : [];
}

async function readProfile(root: string, profile: string): Promise<RawProfile | null> {
  const text = await readWorkspaceFile(workspaceFiles(root), layout.profileConfig(profile));
  if (text === null) return null;
  try {
    return parseDocument(text).toJSON() as RawProfile;
  } catch {
    // A file that will not parse is not this migration's problem to report;
    // `check` has a better sentence for it than "needs migrating" would.
    return null;
  }
}
