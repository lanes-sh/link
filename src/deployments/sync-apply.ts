import { parseDocument } from 'yaml';
import {
  ConfigError,
  parseConfig,
  readWorkspaceFile,
  workspaceFiles,
  writeWorkspaceFile,
  type Config,
} from '#profile';
import { ConfigDocument } from '#cli/config-edit.ts';
import { diffConfigs, keyedArrayFor, type Change } from './sync.ts';
import { isWorkspaceConfig } from './upload.ts';

/**
 * Deciding a difference and writing it down.
 *
 * The rule is union, and refusal where a union is not possible. Anything one
 * side is missing is copied to it; anything both sides hold differently stops
 * the sync and prints the diff. Last-writer-wins was the alternative and it is
 * the failure this whole command exists because of — a copy of a profile
 * quietly replaced another that held six connections it did not.
 *
 * `--prefer` is how a conflict is resolved, and it is deliberately one flag for
 * the whole run rather than a prompt per key: a sync that asks twelve questions
 * is one answered by pressing return, and the twelfth answer is the one that
 * matters.
 */

export type Prefer = 'local' | 'remote';

export interface ProfileSync {
  readonly profile: string;
  readonly changes: readonly Change[];
  /** Only on the local side: the remote file does not exist at all. */
  readonly onlyRemote: boolean;
  readonly onlyLocal: boolean;
}

const profileKey = (profile: string): string => `profiles/${profile}.yaml`;

/** Parse a profile out of a workspace, or `undefined` when it is not there. */
async function readProfile(root: string, profile: string): Promise<Config | undefined> {
  const text = await readWorkspaceFile(workspaceFiles(root), profileKey(profile));
  if (text === null) return undefined;

  // A remote copy that will not parse is a conflict the operator has to look
  // at, not something to overwrite with the local one — it may be the only copy
  // of something.
  try {
    return parseConfig(text, `${root}/${profileKey(profile)}`).config;
  } catch (error) {
    throw new ConfigError(
      `${root}/${profileKey(profile)} could not be read, so it cannot be merged:\n` +
        `  ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}\n` +
        '  Fix it there, or pass --prefer local to overwrite it.',
    );
  }
}

/**
 * The same file, unvalidated, as the source of what actually gets written.
 *
 * The diff compares *validated* configs, because that is the only comparison
 * that gets equality right: `policy.allow: [gmail.*]` and
 * `[{capability: gmail.*}]` are the same grant written two ways, and a raw
 * comparison would call that a conflict.
 *
 * What is written has to come from here all the same. Writing the validated
 * value back means writing every default zod filled in on the way through —
 * `min_instances: 0`, an OAuth token lifetime nobody set — into a file the
 * operator reads. Recovering six connections should not also silently expand
 * three policy rules into a shape they were not written in.
 *
 * The two cannot disagree about whether something is missing: a default is
 * filled in identically on both sides, so it is equal, so it is never a change.
 */
async function readRawProfile(root: string, profile: string): Promise<unknown> {
  const text = await readWorkspaceFile(workspaceFiles(root), profileKey(profile));
  return text === null ? undefined : parseDocument(text).toJSON();
}

/** Every profile either side has, so one that exists only remotely is still seen. */
export async function profilesInEither(local: string, remote: string): Promise<string[]> {
  const names = async (root: string): Promise<string[]> =>
    (await workspaceFiles(root).list('profiles/'))
      .map((entry) => entry.key.slice('profiles/'.length))
      .filter((name) => name.endsWith('.yaml') && !name.endsWith('.example.yaml'))
      .filter((name) => !name.includes('/'))
      .map((name) => name.slice(0, -'.yaml'.length));

  return [...new Set([...(await names(local)), ...(await names(remote))])].sort();
}

/** What differs, for one profile, between the workspace and a target's copy. */
export async function planProfile(
  localRoot: string,
  remoteRoot: string,
  profile: string,
  prefer: Prefer | undefined,
): Promise<ProfileSync> {
  const local = await readProfile(localRoot, profile);
  const remote = prefer === 'local' && local !== undefined
    ? // Told local wins outright: there is nothing to ask the remote copy, and
      // reading it could only produce conflicts already decided.
      undefined
    : await readProfile(remoteRoot, profile);

  return {
    profile,
    changes: diffConfigs(local, remote),
    onlyRemote: local === undefined && remote !== undefined,
    onlyLocal: remote === undefined && local !== undefined,
  };
}

/** The changes that will be written, once `--prefer` has decided the rest. */
export function resolved(changes: readonly Change[], prefer: Prefer | undefined): Change[] {
  return changes.map((change) => {
    if (change.direction !== 'conflict') return change;
    if (prefer === undefined) return change;
    return { ...change, direction: prefer === 'remote' ? 'pull' : 'push' } as Change;
  });
}

/**
 * Write everything the local copy is missing into the local profile.
 *
 * Through `ConfigDocument`, so the comments an operator wrote survive a
 * recovery, and so the result is validated before it lands — a merged config
 * that would not load is a worse outcome than the one being fixed.
 *
 * A keyed-array element is written by rewriting its array. A YAML sequence has
 * no addressable slot for "the entry whose provider is gmail", and merging by
 * index is exactly the comparison this avoided making in the first place.
 */
export async function applyPulls(
  localRoot: string,
  remoteRoot: string,
  profile: string,
  changes: readonly Change[],
): Promise<number> {
  const pulls = changes.filter((change) => change.direction === 'pull');
  if (pulls.length === 0) return 0;

  // A profile local does not have at all is a file copy: there is no document
  // to edit, and every key in it is a pull.
  if (pulls.some((change) => change.path.length === 0)) {
    const text = await readWorkspaceFile(workspaceFiles(remoteRoot), profileKey(profile));
    if (text === null) return 0;
    await writeWorkspaceFile(workspaceFiles(localRoot), profileKey(profile), text);
    return 1;
  }

  const document = await ConfigDocument.open(localRoot, profile);
  const remote = await readRawProfile(remoteRoot, profile);
  if (remote === undefined) return 0;

  const written = new Set<string>();
  for (const change of pulls) {
    const array = keyedArrayFor(change.path);
    const path = array ?? change.path;

    // One write per array, however many of its elements were missing.
    const key = path.join('.');
    if (written.has(key)) continue;
    written.add(key);

    const value = valueAt(remote, path);
    // Absent from the raw document means the remote side only has it as a
    // default, which the local side fills in identically. Nothing to write.
    if (value === undefined) continue;

    document.setIn([...path], value);
  }

  await document.save();
  return written.size;
}

/** Read a path out of the raw document, for handing to `setIn`. */
function valueAt(config: unknown, path: readonly string[]): unknown {
  let value: unknown = config;
  for (const step of path) {
    if (!(typeof value === 'object' && value !== null)) return undefined;
    value = (value as Record<string, unknown>)[step];
  }
  return value;
}

/**
 * Send the local profile up, once it holds everything both sides had.
 *
 * Wholesale rather than key by key, and only *after* the pulls have been
 * applied: at that point the local file is the union, so copying it up makes
 * the remote one the union too. The remote copy has no comments of its own to
 * lose — `uploadWorkspace` wrote it — so there is nothing finer-grained to
 * preserve, and one PUT cannot half-apply a merge.
 */
export async function applyPushes(
  localRoot: string,
  remoteRoot: string,
  profile: string,
  changes: readonly Change[],
): Promise<boolean> {
  if (!changes.some((change) => change.direction === 'push')) return false;

  const text = await readWorkspaceFile(workspaceFiles(localRoot), profileKey(profile));
  if (text === null) return false;

  await writeWorkspaceFile(workspaceFiles(remoteRoot), profileKey(profile), text);
  return true;
}

/**
 * The authored areas inside `data/` — skills and provider manifests.
 *
 * They ride the same allowlist a deploy uploads by, and for the reason that
 * comment gives at length: the list is what keeps a credential store out of a
 * bucket, and a second answer to "which files" is how the two drift. Compared
 * by content, since they are documents rather than config, and differing
 * content is a conflict like any other.
 */
export interface BlobSync {
  readonly key: string;
  readonly direction: 'pull' | 'push' | 'conflict';
}

export async function planBlobs(localRoot: string, remoteRoot: string): Promise<BlobSync[]> {
  const read = async (root: string): Promise<Map<string, Uint8Array>> => {
    const files = workspaceFiles(root);
    const found = new Map<string, Uint8Array>();

    for (const entry of await files.list('')) {
      // `undefined` profile: every profile's authored areas, since sync is
      // scoped to the target and not to one of them.
      if (!isWorkspaceConfig(entry.key) || entry.key.endsWith('.yaml')) continue;
      const bytes = await files.get(entry.key);
      if (bytes !== null) found.set(entry.key, bytes);
    }
    return found;
  };

  const here = await read(localRoot);
  const there = await read(remoteRoot);
  const equal = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, index) => byte === b[index]);

  return [...new Set([...here.keys(), ...there.keys()])].sort().flatMap((key): BlobSync[] => {
    const local = here.get(key);
    const remote = there.get(key);
    if (local === undefined) return [{ key, direction: 'pull' }];
    if (remote === undefined) return [{ key, direction: 'push' }];
    return equal(local, remote) ? [] : [{ key, direction: 'conflict' }];
  });
}

export async function applyBlobs(
  localRoot: string,
  remoteRoot: string,
  blobs: readonly BlobSync[],
): Promise<number> {
  let copied = 0;

  for (const blob of blobs) {
    const from = blob.direction === 'pull' ? remoteRoot : localRoot;
    const to = blob.direction === 'pull' ? localRoot : remoteRoot;

    const bytes = await workspaceFiles(from).get(blob.key);
    if (bytes === null) continue;

    await workspaceFiles(to).put(blob.key, bytes, { contentType: 'application/octet-stream' });
    copied += 1;
  }

  return copied;
}
