import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { layout } from './layout.ts';
import { isRemoteWorkspace } from './files.ts';

/**
 * Where this workspace's endpoint is actually listening.
 *
 * The gap this closes is one every config edit fell into. `lanes link start`
 * serves **every profile in the workspace from one URL** (ADR-009), and that
 * URL is the port of the profile it was started with — but a command that edits
 * a profile derived the address to notify from *that profile's* own
 * `instance.port`. For an edit to the profile `start` was run under the two
 * agree by luck. For any other they do not, and for a profile that has only
 * just been created they cannot: its port is fresh, so nothing has ever
 * listened there.
 *
 * The failure was silent in the way that costs the most time. The endpoint was
 * running and serving the profile; the notify went to a port with nothing
 * behind it; the command reported "saved, and the endpoint will serve this when
 * it next starts", which is the sentence for an endpoint that is *down*. So the
 * operator read a true-sounding line, and their live endpoint went on serving
 * config that had been superseded.
 *
 * ## Why a record and not a search
 *
 * The alternative was to probe every profile's port and notify whichever
 * answered. That works, and it makes every command pay for a wrong assumption
 * by parsing every config in the workspace on the failure path. A record is one
 * read of one small file, and it is written by the only process that actually
 * knows the answer.
 *
 * ## Why it is safe to be stale
 *
 * It is a hint, never a fact. `notifyReload` still has to reach what it names,
 * and the POST is authenticated by this workspace's own token — so the two ways
 * this can be wrong both fail closed:
 *
 *  - **The endpoint is gone.** The pid check below rejects the record, and the
 *    caller falls back to exactly the address it used before this existed.
 *  - **The pid was reused, or another workspace took the port.** The stranger
 *    does not accept this workspace's bearer, so the notify is refused rather
 *    than delivered to the wrong endpoint — which is the hazard `endpointHealth`
 *    was written to warn about, and the reason this is not merely "trust the
 *    file".
 *
 * Local roots only. A deployed target's address comes from the platform, which
 * knows it authoritatively, and a revision must not write its own configuration
 * (ADR-007) — so nothing here ever reaches a bucket.
 */
export interface EndpointRecord {
  /** The MCP URL, exactly as `start` printed it. */
  readonly url: string;
  /** The process serving it, so a reader can tell a live record from a leftover. */
  readonly pid: number;
  /** Every profile it opened, for a caller that needs to know what it covers. */
  readonly profiles: readonly string[];
  readonly startedAt: string;
}

function recordPath(workspaceRoot: string): string {
  return join(workspaceRoot, layout.endpointRecord());
}

/**
 * Note where this process bound, best effort.
 *
 * Never throws. A workspace on a read-only mount, or one the endpoint does not
 * own, is not a reason to fail a `start` that has already bound its socket —
 * the record is an optimisation for other commands, and its absence returns
 * them to the behaviour they had.
 */
export async function writeEndpointRecord(
  workspaceRoot: string,
  record: Omit<EndpointRecord, 'pid' | 'startedAt'>,
): Promise<void> {
  if (isRemoteWorkspace(workspaceRoot)) return;

  const full: EndpointRecord = {
    ...record,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  try {
    await writeFile(recordPath(workspaceRoot), `${JSON.stringify(full, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
    // See above.
  }
}

/** Forget it. Best effort, and absence is the desired end state either way. */
export async function clearEndpointRecord(workspaceRoot: string): Promise<void> {
  if (isRemoteWorkspace(workspaceRoot)) return;

  try {
    await unlink(recordPath(workspaceRoot));
  } catch {
    // Already gone, or never written.
  }
}

/**
 * The record, if one is there and the process it names is alive.
 *
 * A dead pid answers null rather than a URL, because a leftover from a crashed
 * endpoint is worse than nothing: it would send every notify to an address that
 * stopped being right at some point nobody observed, and the fallback it
 * displaced is at least derived from config that is current.
 */
export async function readEndpointRecord(workspaceRoot: string): Promise<EndpointRecord | null> {
  if (isRemoteWorkspace(workspaceRoot)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(recordPath(workspaceRoot), 'utf8'));
  } catch {
    // Absent, unreadable, or half-written by a `start` that is still going.
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Partial<EndpointRecord>;
  if (typeof record.url !== 'string' || typeof record.pid !== 'number') return null;
  if (!isAlive(record.pid)) return null;

  return {
    url: record.url,
    pid: record.pid,
    profiles: Array.isArray(record.profiles) ? record.profiles : [],
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
  };
}

/**
 * Whether a pid is still there, without signalling it.
 *
 * Signal `0` performs the permission and existence checks and delivers nothing.
 * `EPERM` means the process exists and belongs to somebody else, which for this
 * question is still "alive" — the notify that follows is authenticated, so a
 * process we cannot signal is not a process we have to rule out here.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
