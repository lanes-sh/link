import { ConfigDocument } from '../../config-edit.ts';
import {
  findSecrets,
  sealedVaultRef,
  soleGrantFor,
  type Config,
  type TargetConfig,
} from '#profile';
import type { LocatedProfile } from '../../runtime.ts';
import { reasonOf } from '../../output.ts';

/**
 * What a removal could read of the profile it is removing.
 *
 * The seam against `removal.ts` is that this is what a profile *declares* and
 * that is what a removal *deletes*. It exists because the second has to work
 * when the first cannot be had: a `profile.yaml` the schema refuses could be
 * listed but never removed, and every command that might have taken it away
 * resolved it first and failed on the same parse — so the only way out was
 * deleting the file by hand, or the bucket object on a deployed workspace
 * (#219).
 *
 * **The governing property, and the one to keep: what a config that will not
 * load costs is a line that is missing, never one that is wrong.** Removal
 * derives its credential refs from what the profile declares and then keeps only
 * those the store actually holds, so a field this cannot read *shrinks* the
 * plan. It can never point the plan at somebody else's credential. Everything
 * below is arranged to preserve that, and a change here that lets an unread
 * field widen the plan has broken the design rather than extended it.
 *
 * The closed set is a type rather than a docstring on purpose. `removalPlan`
 * reads four things off a config and no more; while that was only written down,
 * a fifth was one careless line away from being added with no degraded reader
 * beside it.
 */

/** The fields a removal reads, named so an unread one can be reported as such. */
export type SubjectField = 'name' | 'grants' | 'auth' | 'knowledge';

export interface RemovalSubject {
  /** The parsed config, or `null` — which is the whole of the degraded mode. */
  readonly config: Config | null;
  /**
   * The profile's name, from the *directory*.
   *
   * **Never from the file.** `layout.blobs(profile)` is what addresses the blob
   * tree, so a hand-edited `instance.profile` reaching it would let `profile
   * remove my_profile` empty `profiles/other/`. The directory is also what the
   * operator typed and what `listProfiles` showed them, which is the only name
   * any of this was ever about.
   */
  readonly name: string;
  /**
   * Whether the file's own `instance.profile` agreed with the directory.
   *
   * The one thing the file's value is needed for is the middle segment of
   * `vault/<profile>/<connection>` — the name under which a sealed document was
   * written. Where the two disagree there are two candidates and no way to
   * choose, so the ref is reported as unreachable rather than guessed at.
   */
  readonly assumedName: boolean;
  /** `auth.authorization.client_id_ref`, where the block is `oidc`. */
  readonly clientIdRef: string | null;
  /** The `lanes_vault` connection this profile grants, `null` where none is. */
  readonly vaultConnection: string | null;
  /** `knowledge.repo`, for the warning that a repository survives a removal. */
  readonly knowledgeRepo: string | null;
  /** The loader's refusal, first line only, as `loadWorkspaceProfiles` squashes it. */
  readonly refusal: string | null;
  /** Fields the file did not yield. Always empty for a parsed config. */
  readonly unread: ReadonlySet<SubjectField>;
}

/** Every field, for a profile whose config loaded. */
export function subjectOf(config: Config): RemovalSubject {
  return {
    config,
    name: config.instance.profile,
    assumedName: false,
    clientIdRef:
      config.auth.authorization?.mode === 'oidc' ? config.auth.authorization.client_id_ref : null,
    vaultConnection: soleGrantFor(config, 'lanes_vault') ?? null,
    knowledgeRepo: config.knowledge?.repo ?? null,
    refusal: null,
    unread: new Set(),
  };
}

const ALL_FIELDS: readonly SubjectField[] = ['name', 'grants', 'auth', 'knowledge'];

/**
 * What could be salvaged of a profile whose config will not load.
 *
 * One path, not two. In the case #219 produces the file is perfectly good YAML
 * whose only fault is `instance.profile`, so every field below reads cleanly and
 * the plan is identical to the one a parsed config would have produced — calling
 * that a lesser removal would be a sentence this code cannot support. A file
 * that will not parse *as YAML* is the same read with nothing to read:
 * `ConfigDocument.open` throws, every field lands in `unread`, and the caller
 * reports four missing lines instead of none.
 *
 * **`findSecrets` before anything is kept.** A parsed config has been through
 * that check on its raw object, deliberately and before the schema
 * (`profile/load.ts`); a salvaged one has not. Without this the degraded path
 * would be the one route by which a config value reaches a terminal, an audit
 * row and a `--json` document unchecked, which is the hole the loader's ordering
 * exists to close.
 */
export async function removalSubject(found: LocatedProfile): Promise<RemovalSubject> {
  if (found.loaded !== null) return subjectOf(found.loaded.config);

  const directory = found.selection.profile;
  const refusal = reasonOf(found.refusal);

  const raw = await rawDocument(found.selection.workspaceRoot, directory);
  if (raw === null) {
    return {
      config: null,
      name: directory,
      assumedName: true,
      clientIdRef: null,
      vaultConnection: null,
      knowledgeRepo: null,
      refusal,
      unread: new Set(ALL_FIELDS),
    };
  }

  // Anything the secret detector flags is dropped rather than carried: it would
  // otherwise be printed in the preview and written into the audit row.
  const flagged = new Set(findSecrets(raw).map((finding) => finding.path));
  const clean = (path: string, value: string | null): string | null =>
    value !== null && flagged.has(path) ? null : value;

  const unread = new Set<SubjectField>();

  const instance = asRecord(raw['instance']);
  const auth = asRecord(raw['auth']);
  const authorization = asRecord(auth?.['authorization']);
  const knowledge = asRecord(raw['knowledge']);

  const declaredName = asString(instance?.['profile']);
  if (declaredName === null) unread.add('name');

  const grants = asArray(raw['grants']);
  if (grants === null) unread.add('grants');

  // **An absent `authorization` block is a complete read, not a gap.** The
  // schema makes it optional and most profiles do not declare one, so treating
  // absence as unread would put "an OIDC client id, if this profile declared
  // one" under every degraded removal ever run. What is unread is an `auth`
  // block that could not be read at all, or an `oidc` one whose ref could not.
  const clientIdRef =
    authorization?.['mode'] === 'oidc'
      ? clean('auth.authorization.client_id_ref', asString(authorization['client_id_ref']))
      : null;

  // An `auth` key that is *there* and unreadable is a gap; one that is absent
  // is not. A profile with no `auth` block declares no `authorization` and so
  // no client id, which is a complete answer — and the common one, since the
  // whole block is optional.
  if (raw['auth'] !== undefined && auth === undefined) unread.add('auth');
  else if (authorization?.['mode'] === 'oidc' && clientIdRef === null) unread.add('auth');

  return {
    config: null,
    name: directory,
    assumedName: declaredName !== directory,
    clientIdRef,
    vaultConnection: grants === null ? null : vaultGrantIn(grants),
    knowledgeRepo: clean('knowledge.repo', asString(knowledge?.['repo'])),
    refusal,
    unread,
  };
}

/**
 * The sealed-vault ref this removal may delete, where it can name one.
 *
 * `null` means "there is no such ref, or this cannot name it" and the caller
 * reports the second case through `unreachableRefs`. Guessing instead would be
 * the one way this design could point a deletion at a name that is not this
 * profile's — every other unread field can only shrink the plan.
 */
export function sealedRefFor(subject: RemovalSubject, declared: TargetConfig): string | null {
  if (declared.vault?.adapter !== 'secret') return null;
  if (subject.config === null && (subject.assumedName || subject.unread.has('grants'))) return null;

  return sealedVaultRef(declared, subject.name, subject.vaultConnection);
}

/**
 * The credential references this profile declares, and only those.
 *
 * Locally the profile is the boundary: its credentials are a file inside its own
 * directory, and deleting the directory is the whole operation. In Secret
 * Manager they are flat names in one project, so two profiles deployed to the
 * same project share a namespace and `list()` hands back the other one's as
 * readily as its own. Deriving from what this profile declares is the only
 * answer that cannot delete something that was never ours, and a secret deleted
 * in the wrong project is not recoverable.
 *
 * The cost is that a genuinely orphaned ref — one whose connection was removed
 * from config long ago — is not derivable and so is not deleted. The caller
 * reports those rather than guessing, which is the honest position: a guess here
 * is indistinguishable from another profile's credential.
 *
 * **A subject rather than a config**, so the same derivation runs whether the
 * file parsed or was salvaged. A field that could not be read contributes no
 * ref, which is the property this whole file is built to preserve.
 */
export function declaredRefs(
  subject: RemovalSubject,
  declared: TargetConfig,
  /**
   * What the profiles that are staying declare.
   *
   * Nothing in here is deleted, however plainly the profile being removed also
   * declares it. The vault ref is read off the target and is identical for every
   * profile there, which once made a sibling's sealed items unrecoverable in
   * this command.
   *
   * **The endpoint token was the sharpest case here and is no longer a case.**
   * Every profile took the default `token_ref: profile/token` out of one
   * per-workspace store, so removing one deleted the token its siblings were
   * served by. What fixed it is not a better survivor check: the token was never
   * a profile's to declare (ADR-068), so removing one cannot reach it now.
   *
   * Survivors always parse — they come from `loadWorkspaceProfiles().loaded` —
   * so the kept set is exact even when the subject's own file is not.
   */
  survivors: readonly RemovalSubject[] = [],
): string[] {
  const refs = new Set<string>();

  // Read off the *target*, not the profile. `vaultTargetSchema` sits inside
  // `targetSchema`, so two targets may seal the same items in different places;
  // taking it from the profile would attach one target's vault to another
  // target's removal.
  //
  // **Through the one spelling, because the name carries the connection.** This
  // said `vault/document`, the contract-2 constant, while `openVault` seals under
  // `vault/<connection>` (ADR-059) — so removing a profile queued a ref nothing
  // had ever written and left the real document behind. Under-deletion rather
  // than over, since the survivor set was wrong the same way and they cancelled,
  // but what stayed behind is sealed credential material belonging to a profile
  // the operator asked to be gone. Per connection also makes the survivor check
  // mean something: two profiles granting different vaults no longer look like
  // one document to it.
  const sealed = sealedRefFor(subject, declared);
  if (sealed !== null) refs.add(sealed);

  // **No connection credentials.** They belong to the workspace now (ADR-057),
  // and every one of them may be granted by a profile that is staying. Removing
  // a profile therefore removes no account and no credential — `lanes link
  // disconnect` is the command that does that, and it is the one that knows how
  // to check whether anybody else still needs the credential first.
  //
  // This is the sharpest edge in the whole decoupling, so `renderPlan` says it
  // out loud rather than leaving an operator to infer it from a short list:
  // "remove the work profile" used to mean "revoke what work could reach", and
  // it does not any more.
  if (subject.clientIdRef !== null) refs.add(subject.clientIdRef);

  // Shared with a profile that is staying, so not ours to delete. Computed the
  // same way for the survivors as for this one, because "what does a profile
  // declare" has to have one answer.
  const kept = new Set(
    survivors.flatMap((other) =>
      [sealedRefFor(other, declared), other.clientIdRef].filter((ref) => ref !== null),
    ),
  );

  return [...refs].filter((ref) => !kept.has(ref));
}

/**
 * What a config that will not load stops this removal from being able to name.
 *
 * Not the same thing as a warning, and kept apart from one for that reason. A
 * warning says "this survives by design" — the repository, the deployed service,
 * the connections every profile shares. These say "this removal cannot see
 * whether it survives", which is the sentence that carries the exit code.
 *
 * Nothing here is ever invisible: `renderPlan` already names every ref the
 * store holds that this removal did not delete, under "present but not declared
 * by this profile". What these lines add is that one of those may have been this
 * profile's and there was no way to tell.
 */
export function unreachableRefs(
  subject: RemovalSubject,
  declared: TargetConfig,
  target: string,
): string[] {
  const missing: string[] = [];
  if (subject.config !== null) return missing;

  if (declared.vault?.adapter === 'secret' && sealedRefFor(subject, declared) === null) {
    missing.push(
      `a sealed vault document, if this profile granted one — look under vault/${subject.name}/ ` +
        `in ${target}'s credential store`,
    );
  }

  if (subject.unread.has('auth')) {
    missing.push(
      `an OIDC client id, if this profile declared one — it would be among the refs listed above ` +
        `as ${target}'s, not this profile's`,
    );
  }

  return missing;
}

/** The document as plain data, or `null` where there is nothing to read. */
async function rawDocument(
  workspaceRoot: string,
  profile: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await ConfigDocument.open(workspaceRoot, profile)).toJSON();
    return asRecord(parsed) ?? null;
  } catch {
    // Not valid YAML, an alias cycle, or gone between the two reads. None of it
    // is worth failing a removal over — the caller is about to delete the file
    // either way, and every field is reported unread.
    return null;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);

/** `soleGrantFor(config, 'lanes_vault')`, over rows that have been through no schema. */
function vaultGrantIn(grants: readonly unknown[]): string | null {
  for (const grant of grants) {
    const connection = asString(asRecord(grant)?.['connection']);
    if (connection?.startsWith('lanes_vault.')) return connection.slice('lanes_vault.'.length);
  }
  return null;
}
