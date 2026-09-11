import type { SecretStore } from '#secrets';
import { anyIssuedToken, openTarget, readEndpointRecord, type Config } from '#profile';
import { publishWorkspace } from '#deployments/upload.ts';
import { openSecretStoreFor, type Runtime } from './runtime.ts';
import { deployedUrl, localUrl } from './endpoint-url.ts';

/**
 * Getting an edit to the endpoint that has to serve it.
 *
 * A config edit used to reach a deployed endpoint by exactly one route: roll a
 * new revision. That put "which accounts can this reach" on the same command as
 * "what code does this run", and made connecting an account cost a Docker
 * build. ADR-029 separates them — an edit publishes itself and says so, and
 * `deploy` goes back to being about code.
 *
 * Two steps, and the second is allowed to fail. Publishing is what makes the
 * change *durable* for the next instance to boot; notifying is what makes it
 * visible to the one already running. An endpoint that is not up yet, is
 * scaled to zero, or sits behind a network this machine cannot cross is not a
 * failed edit — it will read the published config when it next starts. So a
 * notify that cannot land is reported, never thrown.
 */

/** How long to wait for a running endpoint to answer. */
const NOTIFY_TIMEOUT_MS = 10_000;

export interface PublishOutcome {
  /** Where the config was copied, when the target reads from a store. */
  readonly published?: string;
  /** Whether a running endpoint confirmed it is now serving the edit. */
  readonly served: boolean;
  /**
   * How many tools the endpoint advertises now, when it answered.
   *
   * Reported rather than inferred, for the same reason `served` is: the number
   * that matters is the one the endpoint would hand a client, and only the
   * endpoint knows it.
   */
  readonly tools?: number;
  /** The endpoint that was told, or would have been. */
  readonly url?: string;
  /** Why it is not being served yet, in a form fit to print. */
  readonly reason?: string;
  /**
   * Whether the endpoint answered and left the edit out, as opposed to not
   * answering at all.
   *
   * The two need different last sentences and that is the whole of why this
   * exists. "The endpoint will serve this when it next starts" is true of a
   * notify that could not land — the config is published and the next boot
   * reads it — and false of a reload that ran and refused the profile, because
   * a restart re-runs the same open and fails it the same way.
   */
  readonly refused?: boolean;
}

/**
 * Copy the config where this target reads it, then tell it to re-read.
 *
 * The order is load-bearing: an endpoint told to reload before the config it
 * should read has landed would reload the previous config and report success.
 */
export async function publishAndNotify(input: {
  /**
   * Absent where the profile's config would not load (#219).
   *
   * `publishWorkspace` never reads it — it copies what the local store holds —
   * and `notifyReload` wants it only for `localUrl`, the last of three answers
   * to "where is the endpoint" and the one that only applies when nothing is
   * recorded as running. So a removal whose config would not parse still
   * publishes and still notifies a deployed target or a recorded local one,
   * which is exactly when the notify matters most: the endpoint may be serving
   * that profile right now from a config that parsed at its last boot.
   */
  readonly config?: Config | undefined;
  readonly workspaceRoot: string;
  readonly target: string;
  /** Every profile the edit touched. See `publishWorkspace`. */
  readonly profile: string | readonly string[];
  readonly credentials: SecretStore;
}): Promise<PublishOutcome> {
  let published: string | null = null;

  try {
    published = await publishWorkspace(input);
  } catch (error) {
    // The local edit already succeeded and is already on disk. What failed is
    // getting it to the bucket, which means the *next* revision would not see
    // it either — worth saying loudly, and not worth undoing the edit for.
    return {
      served: false,
      reason: `could not publish the config to this target: ${message(error)}`,
    };
  }

  const notified = await notifyReload(input);
  return { ...(published ? { published } : {}), ...notified };
}

/** The same thing, for a command that already holds an open runtime. */
export function publishRuntimeEdit(runtime: Runtime): Promise<PublishOutcome> {
  return publishAndNotify({
    config: runtime.config,
    workspaceRoot: runtime.resolution.workspaceRoot,
    target: runtime.target,
    profile: runtime.resolution.profile,
    credentials: runtime.credentials,
  });
}

/**
 * The same thing for a command that resolved a profile but opened no runtime.
 *
 * `policy allow` and `policy deny` edit the config without needing a registry,
 * a dispatcher or a state handle — and a deny that a deployed endpoint has not
 * heard about is the one kind of staleness worth being strict about, so they
 * still have to publish. `openSecretStoreFor` is the cheap half of a runtime:
 * the credential store alone, which is all the notify needs to authenticate.
 */
export async function publishProfileEdit(input: {
  readonly resolution: { readonly workspaceRoot: string; readonly profile: string };
  /** Absent where the profile's config would not load — see `publishAndNotify`. */
  readonly config?: Config | undefined;
  readonly target: string;
  /** Every profile the edit touched, where it reached more than the one named. */
  readonly touched?: readonly string[] | undefined;
}): Promise<PublishOutcome> {
  const credentials = await openSecretStoreFor(input.resolution.workspaceRoot, input.target);

  return publishAndNotify({
    config: input.config,
    workspaceRoot: input.resolution.workspaceRoot,
    target: input.target,
    profile: input.touched ?? input.resolution.profile,
    credentials,
  });
}

/** Ask a running endpoint to re-read its config. Never throws. */
async function notifyReload(input: {
  readonly config?: Config | undefined;
  readonly workspaceRoot: string;
  readonly target: string;
  /**
   * Every profile the edit touched, checked against what the reload actually
   * opened. Optional because `publishRuntimeEdit` and the local paths have
   * nothing to check — see `missingFrom`.
   */
  readonly profile?: string | readonly string[] | undefined;
  readonly credentials: SecretStore;
}): Promise<PublishOutcome> {
  let url: string;
  try {
    // Three answers, in the order of who actually knows.
    //
    // **The platform**, for a deployed target. A loopback URL sent to a
    // deployment reaches a port with nothing behind it, which is the bug this
    // function's own doc comment records.
    //
    // **The endpoint itself**, for a local one. `start` serves every profile in
    // the workspace from one URL, and that URL is the port of the profile it was
    // started with — so deriving it from the *edited* profile's `instance.port`
    // was right only when those happened to be the same profile, and could
    // never be right for a profile that had only just been created. The record
    // is written by the process that bound the socket; see `endpoint-record.ts`
    // and ADR-074.
    //
    // **The config**, when there is no record — a workspace whose endpoint has
    // never run under this version, or is not running at all. That is the
    // address this used unconditionally, so nothing is worse off for falling
    // back to it.
    const { declared } = await openTarget(input.workspaceRoot, input.target);
    const deployed = await deployedUrl(declared.deploy);
    const recorded = deployed ? null : await readEndpointRecord(input.workspaceRoot);
    const local = input.config ? localUrl(input.config) : null;
    const base = deployed ?? recorded?.url ?? local;

    // Nothing deployed, nothing recorded, and no config to derive a port from.
    // There is no endpoint to tell, and saying so is better than guessing at a
    // port — this is only reachable from a removal whose config would not load.
    if (base === null) {
      return {
        served: false,
        reason:
          'nothing is recorded as listening for this workspace, so there is no endpoint to tell',
      };
    }
    url = base.replace(/\/mcp$/, '/reload');
  } catch (error) {
    return { served: false, reason: `could not work out where the endpoint is: ${message(error)}` };
  }

  // Any row the workspace holds (ADR-068). Which one is not a choice worth
  // making here: this is the operator's own command reaching the operator's own
  // endpoint, and `/reload` cares that the caller is authenticated rather than
  // who they are.
  const held = await anyIssuedToken(input.workspaceRoot, input.credentials);
  if (!held) {
    return {
      served: false,
      url,
      // Not a failure to fix in most cases, which is why it reads as a reason
      // rather than an error. An endpoint serving browser clients needs no
      // static token; what it costs is that a config change is picked up on the
      // next reconcile instead of immediately.
      reason: 'no static token is issued in this workspace, so the endpoint cannot be notified',
    };
  }
  const token = held.value;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { served: false, url, reason: `the endpoint answered ${response.status}` };
    }

    const body = (await response.json()) as {
      reloaded?: unknown;
      reason?: unknown;
      tools?: unknown;
      profiles?: unknown;
    };
    if (body.reloaded !== true) {
      return {
        served: false,
        url,
        reason:
          typeof body.reason === 'string'
            ? `the endpoint could not reload: ${body.reason}`
            : 'the endpoint did not reload',
      };
    }

    // `reloaded: true` says a generation swapped, not that this edit is in it.
    // `openReconciled` skips a profile it cannot open rather than failing the
    // endpoint for its siblings, so a reload that answers success is exactly
    // what a skipped profile looks like from here — which is why this was
    // reported as served for as long as the field went unread.
    const missing = missingFrom(body.profiles, input.profile);
    if (missing.length > 0) {
      return { served: false, refused: true, url, reason: notServing(missing) };
    }

    return {
      served: true,
      url,
      ...(typeof body.tools === 'number' ? { tools: body.tools } : {}),
    };
  } catch {
    // Nothing listening, scaled to zero, or unreachable from here — all of
    // which resolve themselves the next time the endpoint starts, because the
    // config it reads on the way up is the one just published.
    return { served: false, url, reason: 'no endpoint answered' };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
}

/**
 * Which of the touched profiles the reload did not open.
 *
 * **Silent unless the endpoint answered the question.** An endpoint from before
 * `/reload` carried `profiles` returns no such field, and an older one is
 * exactly what a workspace mid-upgrade is talking to — so an absent or
 * non-array field means "not answered" and yields nothing, rather than
 * reporting every profile as missing. The check can only ever *demote* a claim
 * the endpoint actively contradicted.
 *
 * `profiles` here is `Generation.names()` unfiltered, unlike the per-principal
 * list `/health` returns, so a name absent from it really was not opened rather
 * than merely not visible to this caller.
 *
 * Exported for its tests: the decision is the whole of the fix, and reaching it
 * through `notifyReload` would mean standing up a credential store and a target
 * to resolve a URL that the case under test never depends on.
 */
export function missingFrom(
  reported: unknown,
  touched: string | readonly string[] | undefined,
): readonly string[] {
  if (!Array.isArray(reported) || touched === undefined) return [];

  const served = new Set(reported.filter((name): name is string => typeof name === 'string'));
  const names = typeof touched === 'string' ? [touched] : touched;
  return names.filter((name) => !served.has(name));
}

/**
 * What to say when the endpoint reloaded and left the edit out.
 *
 * Deliberately not the "will serve this when it next starts" tail
 * `nextAfterEdit` ends on: a restart re-runs the same open and fails it the same
 * way. The two causes are a profile whose grants name a connection this
 * workspace does not hold, and a profile whose per-profile credentials no
 * binding covers — the second of which `profile add` now provisions, and which
 * is worth naming because it is otherwise indistinguishable from the first.
 */
function notServing(missing: readonly string[]): string {
  const which = missing.length === 1 ? `"${missing[0]}"` : missing.map((n) => `"${n}"`).join(', ');
  return (
    `the endpoint reloaded and did not open ${which} — the config is published, and the ` +
    'endpoint refused it. Its log says why, on a line starting "not serving"; the usual cause ' +
    'is credentials nothing has provisioned yet'
  );
}

/**
 * The line `connect` and friends print last.
 *
 * It used to be a guess derived from whether the target was deployable —
 * "restart it" or "roll a revision" — because there was no way to know. There
 * is now: the endpoint either answered or it did not.
 */
export function nextAfterEdit(outcome: PublishOutcome): string {
  if (outcome.served) {
    const served = 'Serving it now — the endpoint has re-read its config.';
    if (outcome.tools === undefined) return served;

    // The second half of the truth, and the half an operator is actually
    // looking at. The endpoint re-reading its config is not the same event as
    // the client in front of them learning about it: a client fetches
    // `tools/list` when it connects and holds the answer, and this endpoint
    // cannot tell it otherwise — it is stateless, so there is no stream on
    // which to send `notifications/tools/list_changed`, and it no longer claims
    // there is (ADR-032).
    //
    // So the tool count goes here, where the change happened, and so does the
    // one action that picks it up. Without this line the command reports
    // success and the operator watches a connector that never changes.
    //
    // Worded for either direction, because `policy deny` prints this too and a
    // deny is the case this file already calls "the one kind of staleness worth
    // being strict about". "Pick them up" was written for a `connect` and read
    // as nonsense after a deny, where the client is holding one tool too many
    // rather than one too few — and where the stale entry is a tool the model
    // will keep calling until it is gone.
    return (
      `${served}\n` +
      `  ${outcome.tools} tools are advertised now. A client connected before this is still\n` +
      `  holding the list it fetched then — reconnect it to match.`
    );
  }

  // Naming the URL, because the likeliest reason nothing answered is that the
  // endpoint is somewhere else: `lanes link start --port` moves the socket
  // without moving `instance.port`, which is where this address comes from.
  const where = outcome.url ? ` at ${outcome.url}` : '';

  // An endpoint that answered and refused is not waiting for a restart to fix
  // it, so it does not get the sentence that says so. See `refused`.
  if (outcome.refused === true) return `${outcome.reason ?? 'the edit is not being served'}${where}.`;

  return `${outcome.reason ?? 'no endpoint answered'}${where} — saved, and the endpoint will serve this when it next starts.`;
}
