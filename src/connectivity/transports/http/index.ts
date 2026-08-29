import type { McpOpenAPITool, ParameterMapper } from 'mcp-from-openapi';
import { withLegalKeys } from './keys.ts';
import { shortenName } from '../mcp/index.ts';
import {
  READ_BUNDLE,
  WRITE_BUNDLE,
  type Connector,
  type ConnectorContext,
  type DiscoveredCapability,
  type ToolResult,
} from '#connectivity';

/**
 * The `http` connector — a REST API described by OpenAPI.
 *
 * This is what stops the next service without an MCP server becoming another
 * 612 lines. An operation becomes a capability mechanically: `mcp-from-openapi`
 * resolves `$ref`s and `allOf`, merges path, query, header, and body parameters
 * into one input schema, and hands back a mapper describing where each argument
 * belongs in the request. We contribute the bundle split, the filtering, and
 * the auth — never per-endpoint translation.
 */

export interface HttpConnectorOptions {
  readonly baseUrl: string;
  /** URL or filesystem path to an OpenAPI 3.x document. */
  readonly openapi: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Sent on every request. Never `Authorization` — the manifest refuses it. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The one body encoding that is not JSON often enough to be worth knowing about.
 *
 * A form-encoded write is not a legacy curiosity: it is what a large share of
 * APIs that predate JSON request bodies still require, and one of them refusing
 * `application/json` is not a negotiation — the request fails outright, with an
 * error about the parameters rather than about the encoding.
 */
const FORM_ENCODED = 'application/x-www-form-urlencoded';

/**
 * What the *document* says the body is, rather than what we would prefer.
 *
 * `mcp-from-openapi` records the declared media type on each body entry of the
 * mapper, so this needs nothing threaded through `target` — the mapper is
 * already cached there, which is what lets a cold instance encode correctly
 * without re-reading the spec.
 *
 * JSON is the default because an operation with no declared request body has no
 * media type to read, and because it is what this connector always sent.
 */
function bodyContentType(mapper: readonly ParameterMapper[]): string {
  for (const entry of mapper) {
    if (entry.type !== 'body') continue;
    const declared = entry.serialization?.contentType;
    if (declared) return declared;
  }

  return 'application/json';
}

/**
 * Arrays repeat rather than join, for the reason the query string does above.
 *
 * A nested object is JSON inside the field, which is the only thing a
 * form-encoded body can do with one — there is no standard spelling of nesting
 * here, and every API that accepts one accepts it as a string.
 */
function encodeBody(body: Readonly<Record<string, unknown>>, contentType: string): string {
  if (!contentType.startsWith(FORM_ENCODED)) return JSON.stringify(body);

  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const element of value) {
        if (element !== undefined && element !== null) form.append(key, String(element));
      }
      continue;
    }

    form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  return form.toString();
}

/**
 * `*` matches any run of characters; anything else is literal.
 *
 * Matched against operationId, path, and tags, because which of those an
 * operator reaches for depends entirely on how the vendor wrote their spec.
 */
export function globMatches(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`, 'i').test(value);
}

/**
 * The HTTP method decides the bundle.
 *
 * A spec yields meaningful read/write groups with no curation, which is what
 * lets `connect` grant something sensible by default on an API nobody has
 * hand-classified. GET and HEAD are the only verbs that are reliably safe.
 */
export function bundleForMethod(method: string): string {
  return /^(get|head)$/i.test(method) ? READ_BUNDLE : WRITE_BUNDLE;
}

function selected(tool: McpOpenAPITool, options: HttpConnectorOptions): boolean {
  const candidates = [
    tool.metadata.operationId ?? '',
    tool.metadata.path,
    tool.name,
    ...(tool.metadata.tags ?? []),
  ].filter(Boolean);

  const matches = (patterns: readonly string[]): boolean =>
    patterns.some((pattern) => candidates.some((candidate) => globMatches(pattern, candidate)));

  if (options.exclude?.length && matches(options.exclude)) return false;
  if (options.include?.length) return matches(options.include);
  return true;
}

export function createHttpConnector(options: HttpConnectorOptions): Connector {
  let generated: McpOpenAPITool[] | undefined;

  const load = async (): Promise<McpOpenAPITool[]> => {
    if (generated) return generated;

    // Imported here rather than at the top of the file, so a process that
    // never opens a connector never loads it. `mcp-from-openapi` brings a
    // swagger parser and a YAML parser of its own, around two and a half
    // megabytes with its transitive tree.
    //
    // Measured, and worth being accurate about: this buys **no** startup time
    // that a stopwatch can see — `audit verify` runs in 0.16s either way. It is
    // here for the same reason `deployments/target.ts` imports its cloud
    // adapters inside their branch: code that cannot run should not be loaded,
    // so a parser bug or a supply-chain problem in it cannot reach a process
    // that was never going to call it. The types above are `import type` and
    // cost nothing either way.
    const { OpenAPIToolGenerator } = await import('mcp-from-openapi');

    // `fromURL` performs SSRF checks on the spec URL, which matters because the
    // URL comes from an operator-supplied manifest and this process can reach
    // the local network.
    const generator = /^https?:/i.test(options.openapi)
      ? await OpenAPIToolGenerator.fromURL(options.openapi)
      : await OpenAPIToolGenerator.fromFile(options.openapi);

    generated = await generator.generateTools();
    return generated;
  };

  return {
    kind: 'http',

    async discover(context): Promise<DiscoveredCapability[]> {
      const tools = await load();
      const chosen = tools.filter((tool) => selected(tool, options));
      const names = chosen.map((tool) => tool.name);

      return chosen.map((tool) => {
        // Google's operationIds are already namespaced — `gmail.users.labels.list`
        // — so without this the wire name becomes `gmail_gmail_users_labels_list`.
        // Same fix, and the same reason, as the Notion tools named `notion-*`.
        const name = shortenName(context.manifest.id, tool.name, names);

        // Appended, never substituted. A generated description says what the
        // arguments are and nothing about what the capability is *for*, because
        // the vendor wrote the document for someone who already knows the
        // product. The manifest is not the authority on the first half, so it
        // adds to it rather than replacing it.
        const described =
          tool.description || `${tool.metadata.method.toUpperCase()} ${tool.metadata.path}`;
        const hint = context.manifest.hints?.[name];

        const legal = withLegalKeys(
          tool.inputSchema as unknown as Record<string, unknown>,
          tool.mapper as unknown as ParameterMapper[],
        );

        return {
          name,
          description: hint ? `${described}\n\n${hint}` : described,
          inputSchema: legal.schema,
          bundle: bundleForMethod(tool.metadata.method),
          // Everything needed to rebuild the request without re-reading the spec,
          // so a cold instance serves from the cache alone.
          target: {
            path: tool.metadata.path,
            method: tool.metadata.method,
            mapper: legal.mapper as unknown as Record<string, unknown>[],
          },
        };
      });
    },

    async invoke(capability, args, context: ConnectorContext): Promise<ToolResult> {
      const method = String(capability.target?.['method'] ?? 'get').toUpperCase();
      const template = String(capability.target?.['path'] ?? '');
      const mapper = (capability.target?.['mapper'] ?? []) as ParameterMapper[];

      const url = new URL(options.baseUrl.replace(/\/$/, '') + buildPath(template, args, mapper));
      const headers = new Headers({ accept: 'application/json' });

      // After `accept`, which is a default worth overriding, and before the
      // operation's own header parameters, which are narrower than a header
      // declared once for the whole connector.
      for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);

      const body = collect(args, mapper, 'body');

      for (const [key, value] of Object.entries(collect(args, mapper, 'query'))) {
        if (value === undefined) continue;

        // An array is repeated, not joined. OpenAPI's default for a query
        // parameter is `style: form, explode: true`, which means one occurrence
        // per element — and `String(['From','Subject'])` produces the single
        // value `From,Subject` instead. That failed silently and specifically:
        // Gmail's `metadataHeaders` matched no header name at all, so asking
        // for From and Subject returned a message with an empty header list
        // and no error to explain it.
        if (Array.isArray(value)) {
          for (const element of value) {
            if (element !== undefined && element !== null) url.searchParams.append(key, String(element));
          }
          continue;
        }

        url.searchParams.set(key, String(value));
      }
      for (const [key, value] of Object.entries(collect(args, mapper, 'header'))) {
        if (value !== undefined) headers.set(key, String(value));
      }

      const hasBody = Object.keys(body).length > 0;
      const contentType = bodyContentType(mapper);
      // Last, so it beats a connector-wide header. Which encoding an operation
      // uses is the document's to state, and a blanket `content-type` that
      // silently changed it would be a bug nobody could see from the manifest.
      if (hasBody) headers.set('content-type', contentType);

      // Auth is attached by core, from the manifest's auth kind or its strategy.
      // A connector never sees a raw credential.
      const request = await context.authorize(
        new Request(url.href, {
          method,
          headers,
          ...(hasBody ? { body: encodeBody(body, contentType) } : {}),
          signal: context.provider.signal,
        }),
      );

      const doFetch = options.fetch ?? globalThis.fetch;
      const response = await doFetch(request);

      // Cloned so a verifier can read the body without consuming it for us.
      await context.verify?.(response.clone() as unknown as Response);

      const text = await response.text();
      if (!response.ok) {
        return {
          content: [{ type: 'text', text: `${response.status} ${response.statusText}\n${text}` }],
          isError: true,
        };
      }

      // A write that answers 204 has confirmed itself, but an empty string is not
      // a confirmation an agent can read — it is indistinguishable from a call
      // that did nothing, and settling it cost a second, read-only call. Every
      // other transport synthesises a receipt for this reason: `{ deleted: true,
      // uid, … }` in dav, `{ written: true, path, bytes }` in fs. This one is
      // generic and has no such knowledge to draw on, so it claims only what the
      // status licenses — that the request succeeded. A body that exists, `{}`
      // included, is an answer rather than an absent one and passes through.
      if (text.trim() === '') {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ ok: true, status: response.status }, null, 2) },
          ],
        };
      }

      return { content: [{ type: 'text', text }] };
    },
  };
}

/** Substitute `{param}` placeholders from the arguments the mapper marks as path. */
function buildPath(
  template: string,
  args: Readonly<Record<string, unknown>>,
  mapper: readonly ParameterMapper[],
): string {
  const values = collect(args, mapper, 'path');

  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Missing path parameter "${name}"`);
    return encodeURIComponent(String(value));
  });
}

/** Pull the arguments belonging to one part of the request. */
function collect(
  args: Readonly<Record<string, unknown>>,
  mapper: readonly ParameterMapper[],
  location: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const entry of mapper) {
    if (entry.type !== location) continue;
    const value = args[entry.inputKey];
    if (value !== undefined) out[entry.key] = value;
  }

  return out;
}
