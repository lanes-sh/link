import { layout, PROFILE_FILE } from './layout.ts';
import { parseConfig } from './load.ts';
import { readWorkspaceFile, workspaceFiles } from './files.ts';
import { CONNECTIONS_FILE } from './workspace.ts';
import type { BlobStore } from '#stores/blobs';

/**
 * Which profiles declare a subject, and whether their declarations moved.
 *
 * One rule behind four credentials. Membership used to be answered three times:
 * `membersResolver` read every profile's YAML behind a five-second cache for a
 * static token, `endpoint.ts`'s `membersOf` filtered the live runtime map for
 * the OAuth gate and the signed-key link, and `token list` asked a third,
 * uncached way. Three implementations of one sentence is how the answers came
 * to differ, and the difference was not cosmetic: the runtime map holds the
 * profiles that successfully *opened*, so a profile whose credentials nothing
 * had provisioned made its own members look like strangers — including at the
 * mint, which refused the whole sign-in saying no profile listed them.
 *
 * So reach follows what the owner **declared**, never what the endpoint managed
 * to open. A declared profile that is not being served is still a profile this
 * subject is a member of; whether it can be reached is a separate question, and
 * `mergeCapabilities` already answers it by iterating the served map. Nothing
 * here can widen what that filter allows.
 *
 * ## Why this does not call `loadWorkspaceProfiles`
 *
 * Because it cannot afford to. `listProfiles` wraps its listing in
 * `catch { return []; }` and `loadWorkspaceProfiles` buckets every per-profile
 * read failure into `unreadable` and returns `loaded: []` — so a bucket 503, a
 * throttle, or an expired metadata-server token produces *exactly the value*
 * that "this workspace has no profiles" produces. That is survivable while the
 * only consumer is a static token whose absence of rows means the resolver is
 * never called. It stops being survivable the moment an empty answer ends a
 * session: the first storage hiccup would 401 every connected client at once,
 * and a client's correct response to a 401 is to re-authorise, so the reply to
 * a struggling bucket would be a stampede at `/authorize`.
 *
 * This reads the files itself for one reason: to tell **threw** from **empty**.
 * A config that is absent has been removed, and its members lose it. A config
 * that will not load, or a listing that will not complete, is this process not
 * knowing — and not knowing is answered with the last thing it did know.
 *
 * ## Two clocks, and the split is the security property
 *
 * The hot pass re-reads `connections.yaml` and one config per *known* profile:
 * a handful of small reads and **no listing at all**. Every revocation lives
 * here — a member removed, a grant narrowed, a policy denied, a profile deleted
 * — so removal converges within `MEMBERS_TTL_MS` on every instance, with no
 * notify and no fan-out.
 *
 * Discovering a profile that has *appeared* needs the listing, and that is the
 * slow clock. It is the one thing this cannot do quickly, and it is a grant —
 * the direction that is allowed to be slower. `/reload` remains its fast path.
 *
 * The listing is on the slow clock because it is not cheap: `listProfiles` says
 * so in its own comment, and what it means is that the prefix walks every
 * memory entry and asset in every profile on the way past. Putting that on a
 * five-second clock would have made this change a latency regression dressed as
 * a security fix.
 */
export interface WorkspaceMembers {
  /** Every profile whose `members:` names this subject. Empty means none do. */
  profilesFor(subject: string): Promise<readonly string[]>;
  /**
   * A digest of the declared config as of the last good pass, or null before
   * one. Free — the pass that answered `profilesFor` computed it.
   */
  stamp(): string | null;
  /**
   * The same digest, running a pass first if the window has closed.
   *
   * `stamp()` is only ever as fresh as the last `profilesFor`, and which
   * credential authenticated decides whether there has been one: the
   * authenticator chain stops at the first link that succeeds, so a workspace
   * whose callers hold static `llk_` tokens resolves at `BearerAuthenticator`
   * and never reaches the gate or the key link. Those two are what call this
   * resolver, so on such a workspace `stamp()` would stay null forever and
   * anything watching it would never fire — which is most of CI.
   *
   * So a caller that wants the digest *as a question about the config* asks for
   * it here, and pays the window rather than depending on a credential it does
   * not choose. Returns null only while nothing is known, which is the same
   * boot case `profilesFor` throws for; a failure after that serves the last
   * good digest, because reporting a config as unmoved is the safe direction
   * when the alternative is provoking a reload that cannot read it either.
   */
  digest(): Promise<string | null>;
}

/**
 * The window a revocation lands in.
 *
 * Five seconds, which is what `membersResolver` used as a bare literal and what
 * `BearerAuthenticator` independently chose for token rows. Named here because
 * it is now the bound on every revoking direction in the system, which is a
 * number worth being able to find.
 */
export const MEMBERS_TTL_MS = 5_000;

/**
 * The window a profile that has just appeared is discovered in.
 *
 * Twelve times the hot clock, deliberately. This bounds one direction only —
 * granting — and `profile add` publishes, so in practice the endpoint hears
 * about a new profile at once and this is the floor under a notify that did not
 * land, not the usual path. Any shorter and the expensive listing stops being
 * rare.
 */
export const INVENTORY_TTL_MS = 60_000;

/**
 * How long a last-known-good answer may be served while the workspace is unreadable.
 *
 * Unbounded staleness is a revocation bypass, which is what an automated review
 * of the first version of this file said and it was right. Two different faults
 * were being held open by one catch:
 *
 * - A config that will not **parse** is now that profile's problem alone (see
 *   `read`), so the pass still succeeds and every other profile's edits land.
 *   That was the permanent case, and it no longer reaches this ceiling at all.
 * - A workspace that cannot be **read** fails the pass. That is transient by
 *   nature — but not always: credentials revoked for the bucket, or the bucket
 *   deleted, fails every pass forever, and reach frozen forever is exactly the
 *   bypass. So it is bounded.
 *
 * Five minutes rides out any blip worth riding out, and a workspace unreachable
 * for longer is a broken endpoint rather than a hiccup. Past it this throws and
 * the authenticators fail closed, which is the right end state: refusing every
 * caller is visible and recoverable, while serving twelve-hour-old permissions
 * is neither. It is also two orders of magnitude tighter than the window this
 * whole change exists to close.
 */
export const STALE_CEILING_MS = 5 * 60_000;

interface Options {
  readonly ttlMs?: number | undefined;
  readonly inventoryTtlMs?: number | undefined;
  readonly staleCeilingMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  /** Told once per failed pass, with the reason. Kept dependency-free on purpose. */
  readonly onStale?: ((reason: string) => void) | undefined;
  /**
   * The store to read through, where `workspaceFiles(root)` is not wanted.
   *
   * A seam, and it earns itself twice. The read failures this module's whole
   * error handling exists for are a *bucket* misbehaving — a 503, a throttle, an
   * expired metadata-server token — and the filesystem adapter cannot produce
   * one: its `list` swallows `readdir` errors and returns nothing stored yet. So
   * without this the fail-closed and stale-ceiling paths could only be tested
   * against the one adapter that never takes them.
   */
  readonly files?: BlobStore | undefined;
}

/** One read of the declared configs: who is a member, and what the bytes hash to. */
interface Pass {
  readonly bySubject: ReadonlyMap<string, readonly string[]>;
  readonly stamp: string;
}

export function workspaceMembers(root: string, options: Options = {}): WorkspaceMembers {
  const ttl = options.ttlMs ?? MEMBERS_TTL_MS;
  const inventoryTtl = options.inventoryTtlMs ?? INVENTORY_TTL_MS;
  const staleCeiling = options.staleCeilingMs ?? STALE_CEILING_MS;
  const now = options.now ?? Date.now;
  const files = options.files ?? workspaceFiles(root);

  // The last pass that fully succeeded, replaced only as a pair. A half-updated
  // map and stamp would mean reporting a change nobody can see the cause of.
  let good: Pass | null = null;
  let readAt = 0;

  let names: readonly string[] | null = null;
  let namesAt = 0;

  async function inventory(): Promise<readonly string[]> {
    if (names !== null && now() - namesAt < inventoryTtl) return names;

    // Deliberately not `listProfiles`: it swallows. A listing that will not
    // complete has to reach the caller as a failure, or every profile in the
    // workspace reads as deleted.
    const prefix = `${layout.profilesRoot()}/`;
    const entries = await files.list(prefix);
    const found = new Set<string>();

    for (const entry of entries) {
      const rest = entry.key.slice(prefix.length);
      const parts = rest.split('/');

      // `<name>/profile.yaml` since ADR-067, and the flat contract-3 shape
      // beside it, matched the same way `listProfiles` matches them — an
      // unmigrated workspace must not read as holding no profiles.
      if (parts.length === 2 && parts[1] === PROFILE_FILE) {
        found.add(parts[0]!);
        continue;
      }
      if (parts.length === 1 && rest.endsWith('.yaml') && !rest.endsWith('.example.yaml')) {
        found.add(rest.slice(0, -'.yaml'.length));
      }
    }

    names = [...found].sort();
    namesAt = now();
    return names;
  }

  async function read(): Promise<Pass> {

    const hasher = new Bun.CryptoHasher('sha256');
    const bySubject = new Map<string, string[]>();

    // In the stamp because `connect`, `connection declare` and `disconnect`
    // write it, and a reach that followed only the profiles would miss an
    // account arriving or leaving entirely. Absent is ordinary — a workspace
    // that has connected nothing has no file — so null hashes as itself.
    const connections = await readWorkspaceFile(files, CONNECTIONS_FILE);
    hasher.update(`${CONNECTIONS_FILE}\0${connections ?? ''}\0`);

    for (const profile of await inventory()) {
      const key = layout.profileConfig(profile);
      const text = await readWorkspaceFile(files, key);

      // Absent is removed, and that is an answer: its members lose it and its
      // bytes leave the digest, so the removal converges.
      if (text === null) continue;

      // Hashed before it is parsed, deliberately. The digest describes the
      // bytes on disk whether or not they make sense, so repairing a broken
      // config moves the stamp and provokes the reload that picks it up.
      hasher.update(`${key}\0${text}\0`);

      // **One profile's fault is one profile's problem.** This used to throw
      // out of the whole pass, which held every *other* profile's reach at its
      // last known value too — so a single typo in one config suspended
      // revocation across the workspace, permanently, for as long as the typo
      // lasted. Dropped on its own instead, which is also what the endpoint
      // already does with it: `openRuntime` cannot open a profile whose config
      // will not parse, so `openReconciled` skips it and nothing is served
      // under it anyway. Contributing no members matches what is actually
      // reachable, and it fails closed rather than open.
      let members: readonly { readonly subject: string }[];
      try {
        members = parseConfig(text, key).config.members;
      } catch (error) {
        options.onStale?.(error instanceof Error ? error.message : String(error));
        continue;
      }

      for (const member of members) {
        const held = bySubject.get(member.subject) ?? [];
        held.push(profile);
        bySubject.set(member.subject, held);
      }
    }

    return { bySubject, stamp: hasher.digest('hex') };
  }

  async function refreshed(): Promise<Pass> {
    if (good !== null && now() - readAt < ttl) return good;

    try {
      good = await read();
      readAt = now();
      return good;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      // Nothing known yet: a first read against a workspace this process cannot
      // reach. Thrown on, so the authenticators take their existing catch and
      // fail closed, which is the right answer at boot and the only time this
      // path is reachable in a healthy deployment.
      if (good === null) throw error;

      // **Bounded**, because reach frozen forever is a revocation bypass however
      // good the reason for freezing it. `readAt` is only stamped by a pass that
      // succeeded, so this is the age of the answer rather than of the attempt.
      // Past the ceiling it rethrows and the authenticators fail closed.
      if (now() - readAt >= staleCeiling) throw error;

      // Inside it, stale rather than loud, and symmetric: during an outage a
      // grant and a revocation are equally old, so "revocation no slower than
      // granting" still holds. The clock is deliberately not advanced, so the
      // next request retries rather than waiting out the window.
      options.onStale?.(reason);
      return good;
    }
  }

  return {
    async profilesFor(subject) {
      return (await refreshed()).bySubject.get(subject) ?? [];
    },
    stamp() {
      return good?.stamp ?? null;
    },
    async digest() {
      try {
        return (await refreshed()).stamp;
      } catch {
        // Nothing known, which is the boot case. `profilesFor` throws here so
        // the authenticators fail closed; this one is asking whether the config
        // moved, and "no idea" is not news.
        return good?.stamp ?? null;
      }
    },
  };
}

/**
 * The same rule, asked once, with no cache and nothing remembered.
 *
 * `token list` and `token show` print what a row reaches, and they are a person
 * waiting on a command rather than a request on a hot path. They want today's
 * answer, not one up to five seconds old, and they must not leave a
 * last-known-good map behind in a process that is about to exit. One rule, two
 * lifetimes — which is the point of it living beside `workspaceMembers` rather
 * than being a fourth implementation.
 */
export async function declaredMembers(root: string, subject: string): Promise<string[]> {
  const members = workspaceMembers(root, { ttlMs: 0, inventoryTtlMs: 0 });
  return [...(await members.profilesFor(subject))];
}
