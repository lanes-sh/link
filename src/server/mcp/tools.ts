import { annotationsFor } from './annotations.ts';
import { forProfile } from '#auth';
import { fromJsonSchema, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isToolResult } from '#connectivity';
import { clientLabelFrom } from './client-info.ts';
import { toolNameFor } from './naming.ts';
import { resourceLinkRouter } from './routing.ts';
import { sanitizeSchema } from './schema.ts';
import {
  CONNECTION_DESCRIPTION,
  describeWithConnections,
  profileDescription,
} from './description.ts';
import {
  accountsByProfile,
  type BuildServerOptions,
  type MergedCapability,
} from './visibility.ts';

/**
 * Tools — the capability kind everything else is measured against.
 *
 * Two registration paths and one handler. Discovered capabilities carry JSON
 * Schema, because they come from an upstream MCP server or an OpenAPI document;
 * local ones author Zod. Both end up as the same registered tool, with `profile`
 * and `connection` injected either way — ADR-001 does not change just because
 * the schema arrived differently.
 */

/**
 * The two arguments core injects, and no provider declares.
 *
 * Plain strings, not enums — ADR-082. An enum here is a constraint fixed at a
 * moment the caller cannot see the end of: nothing can push
 * `notifications/tools/list_changed` from a stateless endpoint (ADR-002,
 * ADR-032), so a client that cached its list holds the old values for as long as
 * it lives. Every value in that cached enum is still correct, because adding a
 * profile removes none — so the only call the constraint refuses is the one
 * naming what has appeared since.
 *
 * `minLength` stays, and the difference is the whole of the decision: a
 * constraint that cannot go stale is not the kind this removed.
 */
function routingProperties(profiles: string[]): Record<string, unknown> {
  return {
    profile: {
      type: 'string',
      minLength: 1,
      description: profileDescription(profiles),
    },
    connection: {
      type: 'string',
      minLength: 1,
      description: CONNECTION_DESCRIPTION,
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

  const properties = (discovered.inputSchema['properties'] as Record<string, unknown>) ?? {};
  const required = (discovered.inputSchema['required'] as string[]) ?? [];

  server.registerTool(
    toolNameFor(id),
    {
      ...(discovered.title ? { title: discovered.title } : {}),
      description: describeWithConnections(
        discovered.description,
        entry.reachable,
        accountsByProfile(options),
      ),
      annotations: annotationsFor(id, entry.reads),
      // Advertised where the provider declared one. The specification requires
      // a server publishing an output schema to conform to it, and this
      // endpoint hands back the upstream's result unchanged — so the upstream's
      // own schema is exactly the promise being kept.
      ...(discovered.outputSchema
        ? { outputSchema: fromJsonSchema(sanitizeSchema(discovered.outputSchema)) }
        : {}),
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
          properties: { ...properties, ...routingProperties(profiles) },
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
  const shape = (capability.inputSchema as unknown as { shape?: z.ZodRawShape }).shape ?? {};

  server.registerTool(
    toolNameFor(id),
    {
      ...(capability.title ? { title: capability.title } : {}),
      description: describeWithConnections(
        capability.description,
        entry.reachable,
        accountsByProfile(options),
      ),
      annotations: annotationsFor(id, entry.reads),
      inputSchema: {
        ...shape,
        // Injected by core, never declared by a provider — ADR-001. Plain
        // strings since ADR-082: the reachable set is still built from resolved
        // policy and still decides what the description says, but it no longer
        // decides what validates. The filter is `allowedConnections`; the enum
        // was only its rendering, and the rendering is in the description above.
        profile: z.string().min(1).describe(profileDescription(profiles)),
        connection: z.string().min(1).describe(CONNECTION_DESCRIPTION),
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
  return async (args: unknown, extra?: unknown) => {
    const { profile, connection, ...rest } = (args ?? {}) as Record<string, unknown>;

    // The request first, then whatever the transport knew before the call —
    // which on a stateless POST is nothing, and is why the request is asked.
    const label = clientLabelFrom(extra) ?? options.clientLabel;

    const name = String(profile);
    const runtime = options.profiles.get(name);
    const reachable = entry.reachable.get(name);

    // Both arguments are strings, so a caller can name anything at all —
    // including a valid profile with a connection belonging to a different one,
    // which the enums admitted too because they were a union across profiles.
    // Refuse it here rather than dispatching: routing a `work` account through
    // `personal` would cross exactly the boundary profiles exist to hold.
    //
    // This branch is also what withholds a profile now. `options.profiles` holds
    // every profile the endpoint serves and `entry.reachable` is
    // `mayReach`-filtered, so a name that does not exist fails the first test, a
    // name the caller is not a member of fails the second, and both arrive at
    // one sentence — differing only in the name the caller supplied and in their
    // own `Available:` list, which they already held. ADR-079's rule for
    // `/data`, said again for tools: a distinguishable refusal would confirm the
    // profile is there.
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
      principal: forProfile(options.principal, name),
      capabilityId,
      connectionKey: String(connection),
      arguments: rest,
      ...(label ? { clientLabel: label } : {}),
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
      // Required wherever the tool declared an output schema — see `ToolResult`.
      // Not spread: `structuredContent` is `unknown`, and spreading an array or
      // a primitive would quietly turn it into `{}`.
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
      ...(result.isError ? { isError: true } : {}),
    };
  };
}
