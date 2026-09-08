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
  /** Whatever the manifest's connector declares, sent on every request. */
  readonly headers?: Record<string, string> | undefined;
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
 * A readable name for a discovered capability, where the vendor supplied none.
 *
 * MCP's `title` is optional and almost nobody fills it in: it was `undefined` on
 * every one of the 144 tools the vendored specs produce, because an OpenAPI
 * document has a `summary` and an `operationId` and no display name. So a client
 * listing them had only the wire name to show, and — the reason this exists — a
 * client that *defers* tool loading had one less field to rank on.
 *
 * That second use is what makes this more than cosmetic (ADR-075). Tool search
 * is client-side and it matches on names and descriptions, so those two fields
 * are the whole index. The wire name carries the provider id (`gmail_...`) but
 * the vendor's own noun appears nowhere: `Gmail` is in the manifest, and the
 * manifest is not what a client is ranking. Putting it in the title puts it in
 * the index, once per tool, for about twenty-five bytes.
 *
 * The operation reads better reversed. An operationId is written
 * object-then-verb — `users.drafts.list`, `spreadsheets.values.update` — because
 * it is a path; a person says "list drafts". So the last segment leads, the one
 * before it follows, and camelCase is split so `copyTo` reads as words. Deeper
 * segments are dropped rather than joined: `users.` prefixes most of Gmail and
 * says nothing that distinguishes one tool from another.
 *
 * Never overwrites a `title` the vendor did supply. An upstream MCP server that
 * wrote one knows its own product better than this does.
 */
export function titleFor(vendor: string, name: string): string {
  const words = (segment: string) =>
    segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();

  const segments = name.split('.').filter((segment) => segment.length > 0);
  const verb = segments.at(-1);
  const object = segments.at(-2);

  if (verb === undefined) return vendor;
  return object === undefined
    ? `${vendor}: ${words(verb)}`
    : `${vendor}: ${words(verb)} ${words(object)}`;
}

/**
 * The most of an upstream description this endpoint will carry.
 *
 * A cap, not a judgement about writing style. A description is advertised to
 * every caller on every `tools/list`, so an upstream server shipping three
 * thousand words spends the owner's context on every turn.
 */
const LONGEST = 2_000;

/**
 * Text that is trying to be an instruction rather than a description.
 *
 * Deliberately short, and deliberately not presented as complete. This cannot
 * be a filter that catches everything — a sufficiently careful sentence always
 * reads as English — and pretending otherwise would be worse than the honest
 * version, because it would invite trusting the output. What it catches is the
 * shape the published attacks take: a role marker, or a sentence addressed to
 * the model about what it must do before or instead of what it was asked.
 */
const INSTRUCTIONS: readonly RegExp[] = [
  // Role and turn markers. A description is one field of one tool; anything
  // announcing a new speaker inside it is trying to end the field early.
  /<\/?(?:system|assistant|user|tool_call|function_call)[^>]*>/gi,
  /\[\/?INST\]/gi,
  /(?:^|\n)\s*(?:###\s*)?(?:system|assistant|user)\s*:/gi,
  // Sentences aimed at the reader's obedience rather than its understanding.
  /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|messages?|rules?)/gi,
  /disregard\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/gi,
  /(?:you\s+)?must\s+(?:always|first|never)\s+(?:call|invoke|run|use|read)/gi,
  /before\s+(?:using|calling|invoking)\s+(?:any|this|another)\s+tool/gi,
  /do\s+not\s+(?:tell|mention|inform|reveal)\s+the\s+(?:user|owner)/gi,
];

/**
 * An upstream description, made safe to put in front of a model.
 *
 * Most of this endpoint's providers are other people's MCP servers, and their
 * tool descriptions reach the owner's model verbatim. That field is the
 * documented injection surface: a compromised or careless server writes
 * instructions into what reads as help text, and the model follows them,
 * because from where it sits there is nothing to tell the two apart. This
 * endpoint is the gateway all of it passes through, which makes it the one
 * place the check can be made once for every client behind it.
 *
 * **Marked, never silently dropped.** A removed sentence is invisible to
 * everyone, including the operator trying to work out why a tool behaves
 * strangely. A replaced one shows up in `lanes link tools`, in a search result,
 * and in a diff. What the model sees instead is a statement that something was
 * withheld — which is true, and is not itself an instruction.
 *
 * This does not make an untrusted description trustworthy, and nothing here
 * could. It removes the shapes that are unambiguously not description, and
 * bounds what the rest may cost.
 */
export function neutralise(description: string): string {
  let text = description;
  for (const pattern of INSTRUCTIONS) text = text.replace(pattern, '[withheld]');

  // Zero-width and bidirectional control characters, which hide the difference
  // between what a reviewer reads and what a model does.
  text = text.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');

  return text.length > LONGEST ? `${text.slice(0, LONGEST)}… [truncated]` : text;
}

/**
 * The manifest's search vocabulary, on the description that carries it.
 *
 * One line, appended to every capability of a provider that declares
 * `keywords`. Repetitive on purpose: a client's tool search ranks each tool as
 * its own document, so a word present on the provider and absent from the tool
 * is a word that does not match the tool. There is nowhere else to put it.
 *
 * A term already in the description is dropped rather than repeated, which
 * keeps the line to the words that are genuinely missing and stops it growing
 * as vendors improve their own wording.
 */
export function withKeywords(description: string, keywords: readonly string[] = []): string {
  const missing = keywords.filter(
    (term) => !new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(description),
  );

  return missing.length === 0 ? description : `${description}\n\nAlso: ${missing.join(', ')}.`;
}

/**
 * Both of the above, over a capability set a connector already holds.
 *
 * `http` and `mcp` apply the two helpers as they build each tool, because both
 * are turning something foreign — an OpenAPI operation, an upstream tool — into
 * ours and are already rewriting every field. `dav`, `imap` and `fs` are not:
 * their capability sets are fixed in code, written here, and returned from
 * `discover` as they stand. So they had no rewriting step to apply this in, and
 * for the same reason nobody noticed they were skipping it.
 *
 * The result was a whole class of provider with no `title` at all and no way to
 * benefit from `keywords` even once its manifest declared some: thirteen
 * providers, every mailbox that is not Gmail among them. This is the rewriting
 * step, so that a fixed set is as findable as a discovered one.
 *
 * A `title` already on the capability wins, on the same principle `titleFor`
 * states for an upstream one: whoever wrote it knew more than a synthesis does.
 */
export function searchableCapabilities(
  capabilities: readonly DiscoveredCapability[],
  manifest: { readonly name: string; readonly keywords?: readonly string[] | undefined },
): DiscoveredCapability[] {
  return capabilities.map((capability) => ({
    ...capability,
    title: capability.title ?? titleFor(manifest.name, capability.name),
    description: withKeywords(capability.description, manifest.keywords),
  }));
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
        // The declared headers first, so the credential cannot be displaced by
        // one. `defineProvider` already refuses a declared `Authorization`, and
        // this order means a manifest loaded some other way fails safe rather
        // than sending someone else's header in its place.
        headers: {
          ...(options.headers ?? {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
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
          // The upstream title wins where there is one; `titleFor` fills in
          // where there is not, so the vendor's noun reaches the field a
          // deferring client ranks on either way.
          title:
            tool.title ??
            titleFor(context.manifest.name, shortenName(context.manifest.id, tool.name, names)),
          // Neutralised at the boundary, which is here: this is the line where
          // somebody else's text becomes this endpoint's advertisement. Doing
          // it further in would mean every later reader had to remember to.
          description: withKeywords(
            neutralise(tool.description ?? `${context.manifest.name} ${tool.name}`),
            context.manifest.keywords,
          ),
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
