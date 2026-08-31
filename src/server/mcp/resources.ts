import { forProfile } from '#auth';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { isResourceListResult, isResourceResult } from '#connectivity';
import type { DispatchOutcome } from '#dispatch';
import { toolNameFor } from './naming.ts';
import { scopeResourceUri } from './routing.ts';
import type { BuildServerOptions, MergedCapability } from './visibility.ts';

/**
 * Resources — read-oriented context, addressed rather than called.
 *
 * One registration per (profile, connection): a resource URI carries no
 * argument to route on, so both have to live in the URI itself — ADR-006. A
 * read still goes through the dispatcher like everything else, so a resource is
 * policy-checked, rate-limited, and audited on exactly the terms a tool is.
 */
export function registerResource(
  server: McpServer,
  id: string,
  entry: MergedCapability,
  capability: Extract<NonNullable<MergedCapability['capability']>, { kind: 'resource' }>,
  options: BuildServerOptions,
): void {
  for (const [profile, reachable] of entry.reachable) {
    const runtime = options.profiles.get(profile)!;

    for (const connectionKey of reachable) {
      const connectionId = connectionKey.slice(connectionKey.indexOf('.') + 1);
      const scope = { profile, connectionId };
      const scoped = scopeResourceUri(capability.uriTemplate, scope);

      const dispatch = (args: Record<string, unknown>): Promise<DispatchOutcome> =>
        runtime.dispatcher.invoke({
          principal: forProfile(options.principal, profile),
          capabilityId: id,
          connectionKey,
          arguments: args,
          clientLabel: options.clientLabel,
        });

      const metadata = {
        description: `${capability.description} (${profile}: ${connectionKey})`,
        ...(capability.mimeType ? { mimeType: capability.mimeType } : {}),
      };

      // `uri` is the whole argument — the provider recovers its own template
      // variables from it and never sees the routing segments core prepended.
      const read = async (uri: URL) => {
        const outcome = await dispatch({ uri: uri.href });
        if (!outcome.ok) throw new Error(outcome.message);
        if (!isResourceResult(outcome.result)) {
          throw new Error(`${id} did not return resource contents`);
        }

        return {
          contents: outcome.result.contents.map((part) => ({
            // The requested URI, not whatever the provider echoed: MCP requires
            // them to match, and a provider returning its own unscoped form
            // would produce contents a client cannot re-read.
            uri: uri.href,
            ...(part.mimeType ?? capability.mimeType
              ? { mimeType: part.mimeType ?? capability.mimeType! }
              : {}),
            text: part.text,
          })),
        };
      };

      const name = `${toolNameFor(id)}_${profile}_${connectionId}`;

      // A template with nothing to expand is a static resource, and the SDK
      // wants it registered as one — that is what puts it in `resources/list`
      // without a list callback.
      if (!scoped.includes('{')) {
        server.registerResource(name, scoped, metadata, read);
        continue;
      }

      server.registerResource(
        name,
        new ResourceTemplate(scoped, {
          // `undefined` is a deliberate value here, not an omission: the SDK
          // requires the key so that forgetting to enumerate is a decision
          // rather than an oversight. A provider omits `list` when its resource
          // space is unbounded.
          list: capability.list
            ? async () => {
                const outcome = await dispatch({});
                if (!outcome.ok) throw new Error(outcome.message);
                if (!isResourceListResult(outcome.result)) return { resources: [] };

                return {
                  resources: outcome.result.resources.map((resource) => ({
                    name: resource.name,
                    uri: scopeResourceUri(resource.uri, scope),
                    ...(capability.mimeType ? { mimeType: capability.mimeType } : {}),
                  })),
                };
              }
            : undefined,
        }),
        metadata,
        read,
      );
    }
  }
}
