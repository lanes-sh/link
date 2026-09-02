import type { SecretStore } from '#secrets';
import { openTarget, type Config } from '#profile';
import { publishWorkspace } from '#deployments/upload.ts';
import { openSecretStoreFor, type Runtime } from './runtime.ts';
import { endpointUrl } from './endpoint-url.ts';

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
}

/**
 * Copy the config where this target reads it, then tell it to re-read.
 *
 * The order is load-bearing: an endpoint told to reload before the config it
 * should read has landed would reload the previous config and report success.
 */
export async function publishAndNotify(input: {
  readonly config: Config;
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
  readonly config: Config;
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
  readonly config: Config;
  readonly workspaceRoot: string;
  readonly target: string;
  readonly credentials: SecretStore;
}): Promise<PublishOutcome> {
  let url: string;
  try {
    // Answers for a deployed target as well as a local one — a loopback URL
    // sent to a deployment reaches a port with nothing behind it, which is the
    // bug this function's own doc comment records.
    const { declared } = await openTarget(input.workspaceRoot, input.target);
    url = (await endpointUrl(input.config, declared)).replace(/\/mcp$/, '/reload');
  } catch (error) {
    return { served: false, reason: `could not work out where the endpoint is: ${message(error)}` };
  }

  const token = await input.credentials.get(input.config.auth.token_ref);
  if (!token) {
    return {
      served: false,
      url,
      reason: `no profile token at "${input.config.auth.token_ref}" to authenticate with`,
    };
  }

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
  return `${outcome.reason ?? 'no endpoint answered'}${where} — saved, and the endpoint will serve this when it next starts.`;
}
