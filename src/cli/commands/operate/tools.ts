import { toolNameFor } from '#server/mcp';
import { deployedUrl, endpointUrl } from '../../endpoint-url.ts';
import { announce, heading, print, style, warn } from '../../output.ts';
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
 * explained by that flag more often than by anything else.
 */
export async function tools(flags: ToolsFlags): Promise<void> {
  const runtime = await openRuntime(flags);

  try {
    const { token } = await ensureProfileToken(runtime.credentials, runtime.config.auth.token_ref);
    const declared = runtime.config.targets[runtime.target]?.deploy;
    const deployed = await deployedUrl(declared);
    const url = deployed ?? (await endpointUrl(runtime.config, runtime.target));

    const surface = await advertised(url, token);

    if (flags.json) {
      print(JSON.stringify({ url, target: runtime.target, ...surface }, null, 2));
      return;
    }

    announce(runtime.resolution);

    heading('Endpoint');
    print(`  ${url}`);

    if (!surface.reachable) {
      print(warn(`could not ask it: ${surface.reason}`));
      print(
        style.dim(
          '  Nothing here reads the config to guess instead — an endpoint that cannot\n' +
            '  be asked is exactly the case where a guess would be believed.',
        ),
      );
      return;
    }

    // The registry's own ids, wire-spelled, so the grouping below matches what
    // the endpoint actually named rather than what the string looks like.
    const providers = runtime.registry.list().map((entry) => toolNameFor(entry.manifest.id));

    heading(`Advertised to a client (${surface.tools.length})`);
    for (const [provider, names] of byProvider(surface.tools, providers)) {
      print(`  ${style.bold(provider)}  ${style.dim(`${names.length}`)}`);
      for (const name of names) print(`    ${name}`);
    }

    heading('How a client sees it');
    print(`  payload:      ${kb(surface.bytes)} for the whole list`);
    print(`  listChanged:  ${listChangedLine(surface.listChanged)}`);
  } finally {
    await runtime.close();
  }
}

interface Surface {
  readonly reachable: boolean;
  readonly reason?: string;
  readonly tools: readonly string[];
  readonly bytes: number;
  readonly listChanged?: boolean | undefined;
}

/**
 * One `initialize`, one `tools/list`, exactly as a 2025-era client sends them.
 *
 * Deliberately hand-rolled rather than run through an MCP client library: the
 * subject is what the endpoint puts on the wire, and a library that negotiated
 * a newer revision would answer a different question than the one asked.
 */
async function advertised(url: string, token: string): Promise<Surface> {
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

    if (!response.ok) throw new Error(`the endpoint answered ${response.status}`);

    const text = await response.text();
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
      tools: names,
      bytes: Buffer.byteLength(listed.text),
      listChanged: capabilities?.tools?.listChanged,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { reachable: false, reason, tools: [], bytes: 0 };
  }
}

/** The legacy leg answers as SSE, so the payload arrives on a `data:` line. */
function parse(text: string): Record<string, unknown> {
  const body = text.startsWith('event:') || text.startsWith('data:')
    ? (text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '{}')
    : text;

  const message = JSON.parse(body) as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };

  if (message.error) throw new Error(message.error.message ?? 'the endpoint returned an error');
  return message.result ?? {};
}

/**
 * Group by provider, using the ids the registry holds rather than the name.
 *
 * A wire name is the capability id with its dots replaced (`naming.ts`), so
 * `icloud_mail.send_message` arrives as `icloud_mail_send_message` and there is
 * nothing left in the string to say where the provider ends. Splitting on the
 * first underscore would file it under `icloud`, which is not a provider. The
 * ids are known here, so the longest one that matches wins and nothing guesses.
 */
function byProvider(
  names: readonly string[],
  providers: readonly string[],
): Map<string, string[]> {
  const longestFirst = [...providers].sort((a, b) => b.length - a.length);
  const grouped = new Map<string, string[]>();

  for (const name of names) {
    const provider =
      longestFirst.find((id) => name === id || name.startsWith(`${id}_`)) ?? 'other';
    const bucket = grouped.get(provider);
    if (bucket) bucket.push(name);
    else grouped.set(provider, [name]);
  }

  return new Map([...grouped].sort(([a], [b]) => a.localeCompare(b)));
}

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
