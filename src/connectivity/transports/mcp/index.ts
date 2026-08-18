import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type {
  Connector,
  DiscoveryContext,
  DiscoveredCapability,
  ToolResult,
} from '#connectivity';
import { READ_BUNDLE, WRITE_BUNDLE } from '#connectivity';

/**
 * The `mcp` connector — proxy an upstream MCP server.
 *
 * This is what makes Notion and Linear cost a fifteen-line manifest each: the
 * vendor already wrote the integration, and they maintain it. What we add is
 * the thing they do not have — per-capability policy, audit with redaction, and
 * profile isolation in front of it.
 *
 * Capabilities are **discovered**, never declared. The upstream server is the
 * source of truth for what it exposes, and pretending otherwise would mean a
 * manifest going stale every time the vendor ships.
 */

export interface McpConnectorOptions {
  readonly endpoint: string;
  /** Supplies the bearer token for an upstream call; refreshes if needed. */
  readonly accessToken: () => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
}

interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/**
 * Guess a bundle from the upstream tool's own hints.
 *
 * MCP tools may carry a `readOnlyHint`, which is exactly the read/write split
 * we want. Where the hint is absent we fall back to the name, and where that is
 * ambiguous we say `write` — the safer answer, since `read` is what `connect`
 * grants by default and over-granting is the failure that matters.
 */
export function inferBundle(tool: UpstreamTool, name = tool.name): string {
  if (tool.annotations?.readOnlyHint === true) return READ_BUNDLE;
  if (tool.annotations?.readOnlyHint === false) return WRITE_BUNDLE;

  // Fallback for servers that publish no hint. Matched against the *shortened*
  // name and tolerant of hyphens, because vendors separate words however they
  // like — Notion uses `-`, others `_`. An unrecognised verb means `write`,
  // which is the safer default given `read` is what connect grants.
  return /^(get|list|search|read|find|query|fetch|describe|view|download)([-_]|$)/i.test(name)
    ? READ_BUNDLE
    : WRITE_BUNDLE;
}

/**
 * Drop a redundant provider prefix from an upstream tool name.
 *
 * Notion names every tool `notion-*`, which would make our qualified id
 * `notion.notion-search` and the wire name `notion_notion-search`. Stripping it
 * is safe because the original is kept in `target.tool` and is what we actually
 * call — this only affects how the capability is addressed in policy and audit,
 * which is where readability matters.
 *
 * Skipped entirely if stripping would collide with another tool, since a
 * shorter name is never worth routing to the wrong one.
 */
export function shortenName(providerId: string, name: string, all: readonly string[]): string {
  for (const separator of ['-', '_', '.']) {
    const prefix = `${providerId}${separator}`;
    if (!name.startsWith(prefix) || name.length === prefix.length) continue;

    const shortened = name.slice(prefix.length);
    const collides = all.some((other) => other !== name && other === shortened);
    return collides ? name : shortened;
  }
  return name;
}

/**
 * Turn an upstream transport error into something readable.
 *
 * The SDK reports a bad HTTP status by appending the whole response body,
 * which for a large tool list is tens of kilobytes of JSON scrolling past the
 * actual problem. Worse, some servers hide a real explanation inside it:
 * Google answers 403 with a perfectly formed JSON-RPC result whose text says
 * the MCP API is not enabled on the project — the one sentence that tells you
 * what to do, buried in 44KB.
 */
export function readableUpstreamError(error: unknown, endpoint: string): Error {
  const message = error instanceof Error ? error.message : String(error);

  const start = message.indexOf('{');
  if (start === -1) return error instanceof Error ? error : new Error(message);

  try {
    const body = JSON.parse(message.slice(start)) as {
      error?: { message?: string };
      result?: { content?: Array<{ text?: string }> };
    };

    const detail = body.error?.message ?? body.result?.content?.[0]?.text;
    if (detail) {
      return new Error(`${new URL(endpoint).host}: ${detail.trim()}`);
    }
  } catch {
    // Not JSON, or truncated — fall through to the summary below.
  }

  return new Error(`${message.slice(0, start).trim()} (${new URL(endpoint).host})`);
}

export function createMcpConnector(options: McpConnectorOptions): Connector {
  /**
   * A fresh client per operation.
   *
   * Upstream sessions are not reused across requests: the server is stateless
   * and may be replaced between them, so holding a connection would be state we
   * have promised not to keep. Access tokens *are* cached in memory by the
   * caller, so the cost is one HTTP connection rather than a token exchange.
   */
  const connect = async (context: DiscoveryContext): Promise<Client> => {
    const token = await options.accessToken();

    const transport = new StreamableHTTPClientTransport(new URL(options.endpoint), {
      requestInit: {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    } as never);

    const client = new Client(
      {
        name: 'lanes-link',
        version: context.manifest.version,
      },
      {
        // Negotiate the era rather than assuming one. A gateway proxying
        // arbitrary vendors cannot assume they have all moved: Notion and
        // Linear speak the modern handshake-free revision, while Google's
        // Gmail and Drive servers are on 2025-06-18 and answer 403 to anything
        // that arrives before `initialize`. `auto` probes with
        // `server/discover` and falls back to the legacy handshake.
        versionNegotiation: { mode: 'auto' },
      },
    );

    await client.connect(transport);
    return client;
  };

  return {
    kind: 'mcp',

    async discover(context): Promise<DiscoveredCapability[]> {
      const client = await connect(context);

      try {
        const { tools = [] } = (await client.listTools()) as { tools?: UpstreamTool[] };
        const names = tools.map((tool) => tool.name);

        return tools.map((tool) => ({
          name: shortenName(context.manifest.id, tool.name, names),
          ...(tool.title ? { title: tool.title } : {}),
          description: tool.description ?? `${context.manifest.name} ${tool.name}`,
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          bundle: inferBundle(tool, shortenName(context.manifest.id, tool.name, names)),
          // The upstream name is kept verbatim: ours may differ once it has
          // been through name normalisation, and calling the wrong tool
          // upstream would be a silent, expensive mistake.
          target: { tool: tool.name },
        }));
      } catch (error) {
        throw readableUpstreamError(error, options.endpoint);
      } finally {
        await client.close().catch(() => {});
      }
    },

    async invoke(capability, args, context): Promise<ToolResult> {
      const client = await connect(context);
      const upstreamName = (capability.target?.['tool'] as string | undefined) ?? capability.name;

      try {
        const result = (await client.callTool({
          name: upstreamName,
          arguments: args as Record<string, unknown>,
        })) as {
          content?: Array<{ type: string; text?: string; uri?: string; name?: string }>;
          isError?: boolean;
        };

        return {
          content: (result.content ?? []).map((block) =>
            block.type === 'text'
              ? { type: 'text' as const, text: block.text ?? '' }
              : {
                  type: 'resource_link' as const,
                  uri: block.uri ?? '',
                  ...(block.name ? { name: block.name } : {}),
                },
          ),
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (error) {
        throw readableUpstreamError(error, options.endpoint);
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
