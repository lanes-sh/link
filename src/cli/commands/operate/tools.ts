import { capabilityIdForToolName } from '#server/mcp';
import { deployedUrl, endpointHealth, localUrl } from '../../endpoint-url.ts';
import { announce, emit, heading, print, style, warn } from '../../output.ts';
import { ensureProfileToken, openRuntime, type GlobalFlags } from '../../runtime.ts';

export interface ToolsFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
}

/**
 * What a client is actually being told, asked over the wire.
 *
 * Not derived from the config, and that is the whole reason this exists.
 * `doctor` answers whether the credentials resolve and `outputs` answers where
 * the endpoint is; neither answers the question that follows a client showing
 * the wrong tools, which is what the endpoint would hand it right now. Working
 * that out previously meant hand-rolling a `tools/list` with `curl` and a token
 * pulled out of the secret store, and reading a byte count out of a request log
 * to guess at the answer.
 *
 * The `listChanged` line is here for the same reason. A client refreshes by
 * asking again, and a server that claims it will announce changes gives it a
 * reason not to — so a surface that looks stale in a client and current here is
 * explained by that flag more often than by anything else (ADR-032).
 */
export async function tools(flags: ToolsFlags): Promise<void> {
  const runtime = await openRuntime(flags);

  try {
    const { token } = await ensureProfileToken(runtime.credentials, runtime.config.auth.token_ref);
    const declared = runtime.config.targets[runtime.target]?.deploy;
    const deployed = await deployedUrl(declared);
    // Not `endpointUrl`, which asks the platform a second time for an answer
    // this line already has.
    const url = deployed ?? localUrl(runtime.config);

    // Before trusting anything the surface says: two workspaces can assign the
    // same port, and `secrets push` makes their tokens match, so a `--target
    // cloud` whose deployment could not be located answers from loopback with a
    // token that works. Reporting that as the deployed endpoint's surface is
    // the failure `endpoint-url.ts` calls "silent in the worst way".
    const live = await endpointHealth(url, token);
    const mine = live?.profile === runtime.resolution.profile;

    const surface = await askEndpoint(url, token);
    const providers = [...new Set(runtime.registry.capabilities().map(({ id }) => id))];

    await emit(
      flags.json,
      {
        url,
        target: runtime.target,
        // Both, because `--target cloud` reaching loopback is indistinguishable
        // from success without them.
        deployed: deployed !== null,
        answering: mine,
        ...surfaceJson(surface),
      },
      () => {
        announce(runtime.resolution);

        heading('Endpoint');
        print(`  ${url}  ${reachability(mine, deployed !== null, surface)}`);

        if (declared && !deployed) {
          // The case the ownership probe cannot catch on its own: the address
          // is loopback because the platform could not be asked, not because
          // this target is local.
          print(
            warn(
              `could not ask ${declared.platform} where "${declared.service}" is — this is the local endpoint, not the deployed one`,
            ),
          );
        } else if (live && !mine) {
          print(warn(`something else is serving this port: profile "${live.profile}"`));
        }

        if (!surface.reachable) {
          print(fail(surface));
          return;
        }

        heading(`Advertised to a client (${surface.names.length})`);
        for (const [provider, names] of groupByProvider(surface.names, providers)) {
          print(`  ${style.bold(provider)}  ${style.dim(`${names.length}`)}`);
          for (const name of names) print(`    ${name}`);
        }

        heading('How a client sees it');
        print(`  payload:      ${kb(surface.bytes)} for the whole list`);
        print(`  listChanged:  ${listChangedLine(surface.listChanged)}`);
        print(
          style.dim(
            '  Tools only — a skill is a prompt, and is not counted here or by `connect`.',
          ),
        );
      },
    );

    // Non-zero for the same reason `doctor` does it: a command whose whole job
    // is to answer a question exits failing when it could not answer.
    if (!surface.reachable) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

/**
 * What is at this address, in one word.
 *
 * The refusal case is why this is not just `mine`. `/health` is asked with the
 * same token, so an endpoint belonging to another workspace fails that probe
 * too — and reporting "not running" above a refusal that begins "it is
 * answering" is the command contradicting itself in two consecutive lines.
 */
function reachability(mine: boolean, deployed: boolean, surface: Surface): string {
  if (mine) return style.green(deployed ? 'deployed' : 'running');
  if (surface.refused) return style.yellow('answering, but not for this token');
  return style.dim(deployed ? 'not answering' : 'not running');
}

/**
 * Why the surface could not be read, said as the thing that happened.
 *
 * Refused and unreachable are different problems with different fixes, and
 * folding them together sends someone to check whether the endpoint is up when
 * it answered them perfectly well and declined their token.
 */
function fail(surface: Surface): string {
  if (surface.refused) {
    return (
      warn(`the endpoint refused this token: ${surface.reason}`) +
      `\n${style.dim('  It is answering. Either the token was rotated without re-registering, or\n  this address belongs to another workspace.')}`
    );
  }

  return (
    warn(`could not ask it: ${surface.reason}`) +
    `\n${style.dim('  Nothing here reads the config to guess instead — an endpoint that cannot\n  be asked is exactly the case where a guess would be believed.')}`
  );
}

interface Surface {
  readonly reachable: boolean;
  readonly reason?: string;
  /** It answered, and declined. Distinct from not answering at all. */
  readonly refused?: boolean;
  readonly names: readonly string[];
  readonly bytes: number;
  readonly listChanged?: boolean | undefined;
}

/**
 * `tools` as a count, matching `/reload` and `connect`; the names beside it.
 *
 * One key, one meaning. `ReloadResult.tools` and `PublishOutcome.tools` are both
 * numbers, and the count is what `docs/connect.md` tells an operator to compare
 * against their client — shipping the same key here as an array would make
 * `.tools > 5` true for a single tool.
 */
function surfaceJson(surface: Surface): Record<string, unknown> {
  return {
    reachable: surface.reachable,
    ...(surface.reason !== undefined ? { reason: surface.reason } : {}),
    ...(surface.refused !== undefined ? { refused: surface.refused } : {}),
    tools: surface.names.length,
    names: surface.names,
    bytes: surface.bytes,
    ...(surface.listChanged !== undefined ? { listChanged: surface.listChanged } : {}),
  };
}

/**
 * One `initialize`, one `tools/list`, exactly as a 2025-era client sends them.
 *
 * Deliberately hand-rolled rather than run through an MCP client library: the
 * subject is what the endpoint puts on the wire, and a library that negotiated
 * a newer revision would answer a different question than the one asked.
 */
export async function askEndpoint(url: string, token: string): Promise<Surface> {
  const post = async (body: unknown): Promise<{ text: string; result: Record<string, unknown> }> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Both, and not one: the streamable HTTP transport answers 406 to a
        // client that will not accept an event stream, whatever it then sends.
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    if (!response.ok) throw new Refusal(response.status, text);

    return { text, result: parse(text) };
  };

  try {
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'lanes-link-cli', version: '0.0.0' },
      },
    });

    const capabilities = init.result['capabilities'] as
      | { tools?: { listChanged?: boolean } }
      | undefined;

    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = ((listed.result['tools'] as Array<{ name?: string }> | undefined) ?? [])
      .map((tool) => tool.name ?? '')
      .filter((name) => name.length > 0)
      .sort();

    return {
      reachable: true,
      names,
      bytes: Buffer.byteLength(listed.text),
      listChanged: capabilities?.tools?.listChanged,
    };
  } catch (error) {
    if (error instanceof Refusal) {
      return { reachable: false, refused: error.refused, reason: error.message, names: [], bytes: 0 };
    }

    return {
      reachable: false,
      reason: error instanceof Error ? error.message : String(error),
      names: [],
      bytes: 0,
    };
  }
}

/** An endpoint that answered and would not serve this call. */
class Refusal extends Error {
  readonly refused: boolean;

  constructor(status: number, body: string) {
    // The transport puts the actionable reason in a JSON-RPC error body for
    // 400/406/415, and discarding it leaves only a number to act on.
    const detail = errorMessage(body);
    super(detail ? `${status} — ${detail}` : `answered ${status}`);
    this.refused = status === 401 || status === 403;
  }
}

function errorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof parsed.error === 'string') return parsed.error;
    return parsed.error?.message ?? null;
  } catch {
    return null;
  }
}

/**
 * The JSON payload of a response that may or may not be framed as SSE.
 *
 * Three shapes reach here and all three are legal. A plain JSON body; an event
 * stream whose payload line is `data: {…}`; and one where the space after the
 * colon is absent, which the spec permits. The stream may also open with
 * comment lines — the transport arms a keep-alive on every POST, so a handler
 * that runs long enough emits `: keepalive` before anything else — so the
 * payload is found by scanning rather than by inspecting the first characters.
 */
export function parse(text: string): Record<string, unknown> {
  const data = text.split('\n').find((line) => line.startsWith('data:'));
  const body = data === undefined ? text : data.slice('data:'.length).trim();

  const message = JSON.parse(body) as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };

  if (message.error) throw new Error(message.error.message ?? 'the endpoint returned an error');
  return message.result ?? {};
}

/**
 * Group by provider, resolving each wire name back to the capability it is.
 *
 * A wire name is the capability id with its dots replaced (`naming.ts`), so
 * `icloud_mail.send_message` arrives as `icloud_mail_send_message` and there is
 * nothing left in the string to say where the provider ends. Splitting on the
 * first underscore would file it under `icloud`, which is not a provider.
 *
 * `capabilityIdForToolName` answers it exactly against a set of known ids, and
 * falls back to that first-underscore split when it recognises none — which is
 * reachable here, because the registry is the *invoking profile's* while the
 * endpoint may serve several, and under `--target cloud` may run an image this
 * checkout does not have. So the fallback is detected rather than trusted: a
 * name that resolves to nothing known is grouped as unattributed, because a
 * guessed heading with a confident count is worse than an honest "these did not
 * match anything I know about".
 */
export function groupByProvider(
  names: readonly string[],
  capabilityIds: readonly string[],
): Map<string, string[]> {
  const known = new Set(capabilityIds);
  const grouped = new Map<string, string[]>();

  for (const name of names) {
    const id = capabilityIdForToolName(name, capabilityIds);
    const provider = known.has(id) ? id.slice(0, id.indexOf('.')) : UNATTRIBUTED;

    const bucket = grouped.get(provider);
    if (bucket) bucket.push(name);
    else grouped.set(provider, [name]);
  }

  return new Map([...grouped].sort(([a], [b]) => a.localeCompare(b)));
}

/** Named rather than spelled inline, so the output and the test agree. */
export const UNATTRIBUTED = '(not in this profile)';

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function listChangedLine(declared: boolean | undefined): string {
  if (declared === undefined) return style.dim('not declared');
  if (declared === false) {
    return `false  ${style.dim('— a client re-reads this list rather than waiting to be told')}`;
  }

  // Worth a warning rather than a value, because it is the shape of a bug that
  // presents as "the endpoint is wrong" when the endpoint is right: a client
  // that trusts the promise keeps the list it first fetched, for as long as it
  // is registered.
  return style.yellow('true') + style.dim('  — but nothing here sends the notification');
}
