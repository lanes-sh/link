import { z } from 'zod';
import {
  isPrompt,
  isResource,
  isTool,
  type AnyConnector,
  type Capability,
  type CapabilityResult,
  type ConnectorContext,
  type DiscoveredCapability,
  type ProviderDefinition,
} from '#connectivity';

/**
 * The `local` connector — our own code.
 *
 * Thin by design: it exists so dispatch has **one** path rather than branching
 * on whether a provider happens to carry handlers. `example` and the M4 owner
 * layer are the only users.
 *
 * It is also the only connector that serves anything other than tools. A remote
 * kind reports what an upstream server or an OpenAPI document describes, and
 * both describe operations; resources and prompts exist only where we author
 * the capability ourselves. Until M4 this connector dropped them in `discover`
 * and threw in `invoke`, which is why `docs/detailed/init.md`'s "nothing in core changes
 * to add [the owner layer]" was false — the resource path registered in
 * `packages/mcp` could not reach a provider at all.
 */
export function createLocalConnector(definition: ProviderDefinition): AnyConnector {
  return {
    kind: 'local',

    async discover(): Promise<DiscoveredCapability[]> {
      // Local capabilities author Zod; everything downstream speaks JSON Schema,
      // because that is what upstream servers and OpenAPI documents give us.
      // Resources and prompts have no input schema of that shape, so they report
      // an empty one rather than being omitted — a caller counting what a
      // provider exposes should see all of it.
      return definition.capabilities.map((capability) => ({
        name: capability.name,
        ...(capability.title ? { title: capability.title } : {}),
        description: capability.description,
        inputSchema: isTool(capability)
          ? (z.toJSONSchema(capability.inputSchema) as Record<string, unknown>)
          : {},
        ...(bundleFor(definition, capability.name)
          ? { bundle: bundleFor(definition, capability.name)! }
          : {}),
      }));
    },

    async invoke(capability, args, context: ConnectorContext): Promise<CapabilityResult> {
      const found = definition.capabilities.find((entry) => entry.name === capability.name);
      if (!found) {
        throw new Error(`${definition.manifest.id}.${capability.name} is not a capability`);
      }

      if (isTool(found)) {
        const parsed = found.inputSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(invalidArguments(definition, found, parsed.error.issues[0]?.message));
        }

        return found.handler(parsed.data, context.provider);
      }

      if (isResource(found)) {
        // A `uri` argument means "read this one"; its absence means "enumerate".
        // Core is the only caller and passes one or the other — the MCP layer
        // builds both from the registration, so neither is client-supplied.
        const uri = args['uri'];

        if (uri === undefined) {
          if (!found.list) {
            throw new Error(
              `${definition.manifest.id}.${found.name} does not enumerate: its resource space is unbounded.`,
            );
          }
          return { resources: await found.list(context.provider) };
        }

        if (typeof uri !== 'string') {
          throw new Error(`${definition.manifest.id}.${found.name} needs a string uri`);
        }

        return {
          contents: [await found.read(uri, extractParams(found.uriTemplate, uri), context.provider)],
        };
      }

      if (isPrompt(found)) {
        const missing = (found.arguments ?? [])
          .filter((argument) => argument.required && typeof args[argument.name] !== 'string')
          .map((argument) => argument.name);

        if (missing.length > 0) {
          throw new Error(invalidArguments(definition, found, `missing ${missing.join(', ')}`));
        }

        return found.render(stringArguments(args), context.provider);
      }

      // Every branch above returns, so this is unreachable while `Capability`
      // has three members — and becomes a compile error the moment it gains a
      // fourth, which is the point.
      const exhaustive: never = found;
      return exhaustive;
    },
  };
}

function invalidArguments(
  definition: ProviderDefinition,
  capability: Capability,
  detail: string | undefined,
): string {
  return `Invalid arguments for ${definition.manifest.id}.${capability.name}: ${detail ?? 'invalid'}`;
}

/**
 * Prompt arguments are strings on the wire, and a provider's `render` is typed
 * for that. Anything else a caller managed to attach is dropped rather than
 * coerced: a prompt that silently received `"[object Object]"` would be worse
 * than one that received nothing.
 */
function stringArguments(args: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Recover a resource's own template variables from a concrete URI.
 *
 * The MCP SDK matches the *registered* template, which core has already
 * rewritten to carry the profile and connection (see `scopeResourceUri` in
 * `packages/mcp`). Matching the provider's own template here instead means a
 * handler receives exactly the variables it declared and never learns how it
 * was routed — the same separation `ConnectionInfo` gives a tool.
 *
 * Aligned from the right, because the routing segments core prepends are on the
 * left. Deliberately a segment-wise match rather than a general RFC 6570
 * expander: templates in this codebase use simple `{name}` expansion, and a
 * partial implementation of the rest would be a trap.
 */
export function extractParams(template: string, uri: string): Record<string, string> {
  const templateParts = splitUri(template);
  const uriParts = splitUri(uri);
  const params: Record<string, string> = {};

  for (let offset = 1; offset <= templateParts.length; offset += 1) {
    const templatePart = templateParts[templateParts.length - offset]!;
    const uriPart = uriParts[uriParts.length - offset];
    if (uriPart === undefined) break;

    const variable = templatePart.match(/^\{(.+)\}$/);
    if (variable) params[variable[1]!] = uriPart;
  }

  return params;
}

function splitUri(value: string): string[] {
  const scheme = value.indexOf('://');
  return (scheme === -1 ? value : value.slice(scheme + 3)).split('/').filter((part) => part !== '');
}

function bundleFor(definition: ProviderDefinition, capability: string): string | undefined {
  return definition.manifest.bundles?.find((bundle) => bundle.capabilities.includes(capability))
    ?.name;
}
