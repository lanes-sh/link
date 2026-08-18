import { fromJsonSchema, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isToolResult } from '#connectivity';
import { toolNameFor } from './naming.ts';
import { resourceLinkRouter } from './routing.ts';
import { sanitizeSchema } from './schema.ts';
import { describeWithConnections, type BuildServerOptions, type MergedCapability } from './visibility.ts';

/**
 * Tools — the capability kind everything else is measured against.
 *
 * Two registration paths and one handler. Discovered capabilities carry JSON
 * Schema, because they come from an upstream MCP server or an OpenAPI document;
 * local ones author Zod. Both end up as the same registered tool, with `profile`
 * and `connection` injected either way — ADR-001 does not change just because
 * the schema arrived differently.
 */

/** The two arguments core injects, and no provider declares. */
function routingProperties(profiles: string[], connections: string[]): Record<string, unknown> {
  return {
    profile: {
      type: 'string',
      enum: profiles,
      description: 'Which profile to act within',
    },
    connection: {
      type: 'string',
      enum: connections,
      description: 'Which configured account to act on, within that profile',
    },
  };
}

export function registerDiscoveredTool(
  server: McpServer,
  id: string,
  entry: MergedCapability,
  options: BuildServerOptions,
): void {
  const discovered = entry.discovered!;
  const profiles = [...entry.reachable.keys()];
  const connections = [...new Set([...entry.reachable.values()].flat())];

  const properties = (discovered.inputSchema['properties'] as Record<string, unknown>) ?? {};
  const required = (discovered.inputSchema['required'] as string[]) ?? [];

  server.registerTool(
    toolNameFor(id),
    {
      ...(discovered.title ? { title: discovered.title } : {}),
      description: describeWithConnections(discovered.description, entry.reachable),
      // Spread the upstream schema rather than rebuilding it from properties
      // and required alone. Vendors put `$defs` beside those and `$ref` into
      // them — Linear's attachment tools do — and a rebuild drops the
      // definitions while keeping the references, leaving a schema that cannot
      // resolve itself. That failure only appears once a tool using it is
      // actually registered, which is why a catch-all grant surfaced it and a
      // read-only one never did.
      inputSchema: fromJsonSchema(
        sanitizeSchema({
          ...discovered.inputSchema,
          type: 'object',
          properties: { ...properties, ...routingProperties(profiles, connections) },
          required: [...required, 'profile', 'connection'],
        }),
      ),
    },
    makeHandler(id, entry, options),
  );
}

export function registerLocalTool(
  server: McpServer,
  id: string,
  entry: MergedCapability,
  capability: Extract<NonNullable<MergedCapability['capability']>, { kind: 'tool' }>,
  options: BuildServerOptions,
): void {
  const profiles = [...entry.reachable.keys()];
  const connections = [...new Set([...entry.reachable.values()].flat())];
  const shape = (capability.inputSchema as unknown as { shape?: z.ZodRawShape }).shape ?? {};

  server.registerTool(
    toolNameFor(id),
    {
      ...(capability.title ? { title: capability.title } : {}),
      description: describeWithConnections(capability.description, entry.reachable),
      inputSchema: {
        ...shape,
        // Injected by core, never declared by a provider — ADR-001. Both enums
        // are built from resolved policy, so they double as the discovery
        // filter.
        profile: z.enum(profiles as [string, ...string[]]).describe('Which profile to act within'),
        connection: z
          .enum(connections as [string, ...string[]])
          .describe('Which configured account to act on, within that profile'),
      },
    },
    makeHandler(id, entry, options),
  );
}

/**
 * One tool handler, shared by local and discovered capabilities.
 *
 * `connection` is stripped here rather than inside a connector: it is injected
 * by us and means nothing upstream, so forwarding it would leak our routing
 * detail into someone else's API.
 */
function makeHandler(capabilityId: string, entry: MergedCapability, options: BuildServerOptions) {
  // `unknown` because the JSON-Schema overload types it that way; the schema
  // has already validated the shape by the time this runs.
  return async (args: unknown) => {
    const { profile, connection, ...rest } = (args ?? {}) as Record<string, unknown>;

    const name = String(profile);
    const runtime = options.profiles.get(name);
    const reachable = entry.reachable.get(name);

    // The enums are a union across profiles, so a caller can name a valid
    // profile and a connection that belongs to a different one. Refuse it here
    // rather than dispatching: routing a `work` account through `personal`
    // would cross exactly the boundary profiles exist to hold.
    if (!runtime || !reachable) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Profile "${name}" does not offer ${capabilityId}. Available: ${[...entry.reachable.keys()].join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    if (!reachable.includes(String(connection))) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Connection "${String(connection)}" is not part of profile "${name}". Available there: ${reachable.join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    const outcome = await runtime.dispatcher.invoke({
      principal: options.principal,
      capabilityId,
      connectionKey: String(connection),
      arguments: rest,
      clientLabel: options.clientLabel,
    });

    if (!outcome.ok) {
      // A refusal is a tool error rather than a protocol error: the agent should
      // be able to read it, explain it, and pick something else, not lose the
      // connection.
      return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
    }

    // A tool capability always produces a `ToolResult`; the guard is what makes
    // that structural rather than assumed, now that dispatch can return three
    // other shapes.
    if (!isToolResult(outcome.result)) {
      return {
        content: [{ type: 'text' as const, text: `${capabilityId} is not a tool` }],
        isError: true,
      };
    }

    const result = outcome.result;
    const route = resourceLinkRouter(runtime, capabilityId, name, String(connection));

    return {
      content: result.content.map((block) =>
        block.type === 'text'
          ? { type: 'text' as const, text: block.text }
          : { type: 'resource_link' as const, uri: route(block.uri), name: block.name ?? block.uri },
      ),
      ...(result.isError ? { isError: true } : {}),
    };
  };
}
