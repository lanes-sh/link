import { forProfile } from '#auth';
import { isToolResult } from '#connectivity';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { searchCapabilities } from './search-index.ts';
import { SURFACE_TOOL_NAMES, toolNameFor } from './naming.ts';
import { mergeCapabilities, type BuildServerOptions } from './visibility.ts';

/**
 * The two tools whose names never change.
 *
 * Everything else on this surface is one typed tool per capability, and what a
 * client is handed therefore grows when a provider is connected that the profile
 * had none of. A client that re-reads its tool list is unaffected; a client that
 * pinned it at registration serves the old one forever, and in at least one
 * hosted client the connector has to be deleted and re-added before a newly
 * connected provider is reachable at all. That is issue #162, ADR-032 explains
 * why the server cannot fix it by announcing, and ADR-075 is the decision this
 * file implements.
 *
 * `lanes_tools_search` and `lanes_tools_call` are in every list any client has
 * ever fetched from this endpoint — including the first, which under ADR-032's
 * own worst case held two setup tools and nothing else. So the answer to
 * "connect Notion, then use Notion" stops being "start a new session" and
 * becomes a search.
 *
 * **The search returns schemas, not just names.** The published evaluations that
 * make deferred tool loading worth doing attribute its accuracy gain to the
 * model seeing a real schema before it composes arguments — a search that
 * returned only names would keep the token saving and give up the reason. So the
 * strongest matches carry their whole `inputSchema`, and the tail carries a
 * line each. An exact capability id returns that one capability.
 *
 * **The search says which way in to use.** Issue #162 rejected this shape as
 * "two ways to do one thing on one surface … and a model seeing both will
 * sometimes pick the wrong one". The answer is that the search is the authority
 * on routing rather than a peer of it: every result names the typed tool to
 * prefer and says `lanes_tools_call` is for when the caller's own list does not
 * have it. The model can see its tool list and this endpoint cannot — a
 * stateless POST has no idea what a client cached — so the decision belongs to
 * the party holding the information.
 *
 * **Why this is not in the owner layer.** It looks like a ninth `lanes_`
 * provider and it cannot be one. `ProviderContext` states its own invariant —
 * "no `RuntimeState`, no `SecretStore`, no config, no policy engine, and **no
 * way to reach another connection**" — and `call` is exactly a way to reach
 * another connection. `#providers` may not import `#dispatch` or `#policy`
 * either. Both of the things this needs, the merged capability set and the
 * dispatcher, are already here. So it registers alongside `lanes://instructions`
 * — the other thing on this surface that describes it rather than being part of
 * what policy decided.
 *
 * **It widens nothing.** `call` resolves through the same
 * `runtime.dispatcher.invoke` with the same principal, so `allowedConnections`,
 * the profile floor, the rate limits and the audit row are the ones a typed tool
 * would have produced. It refuses a capability that is not in the merged set,
 * which is the same set the typed tools were registered from — so there is no
 * capability reachable through it that was not already advertised. Control-plane
 * operations stay unreachable for the reason ADR-007 gives: they are never
 * registered, so they are never in the set.
 */


/**
 * Register the pair.
 *
 * Unconditionally, and ahead of the loop that registers what policy decided —
 * the same placement and the same argument as `lanes://instructions`. These
 * describe the surface rather than being part of it, and their whole value is
 * that a client which has fetched *any* tool list from this endpoint has them.
 * Registering them conditionally would put the one escape hatch from a stale
 * list behind the thing that goes stale.
 */
export function registerSearchSurface(server: McpServer, options: BuildServerOptions): void {
  const merged = mergeCapabilities(options);
  const profiles = [...options.profiles.keys()];

  server.registerTool(
    SURFACE_TOOL_NAMES[0]!,
    {
      title: 'Search every tool this endpoint can reach',
      description:
        'Find capabilities by keyword and get their argument schemas. ' +
        'Use this when you need something this endpoint plausibly offers and you cannot see a tool for it — ' +
        'a provider connected after your client read its tool list is reachable through here even though ' +
        'it is not in your list. Also use it to get the arguments for one capability by passing its id. ' +
        'Searches only what this caller may reach, so a miss means not connected or not granted.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            'Keywords, or an exact capability id in the form "<provider>.<capability>". ' +
              'Plain words work best — what you want done, not a tool name.',
          ),
      },
    },
    async ({ query }: { query: string }) => ({
      content: [{ type: 'text' as const, text: searchCapabilities(query, merged) }],
    }),
  );

  server.registerTool(
    SURFACE_TOOL_NAMES[1]!,
    {
      title: 'Invoke any tool this endpoint can reach',
      description:
        'Call a capability by id, for when it is not in your tool list. ' +
        'Get the id and its argument schema from lanes_tools_search first — the arguments are ' +
        'that capability\'s own, and this passes them through unchanged. ' +
        'Prefer the named tool wherever your list has one; this exists for the case where it does not. ' +
        'Permissions are identical either way: this reaches nothing you could not otherwise reach.',
      inputSchema: {
        capability: z
          .string()
          .min(1)
          .describe(
            'Capability id, exactly as lanes_tools_search reports it — "<provider>.<capability>"',
          ),
        profile: z.enum(profiles as [string, ...string[]]).describe('Which profile to act within'),
        connection: z
          .string()
          .min(1)
          .describe('Which configured account, within that profile — from the search result'),
        arguments: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("The capability's own arguments, as its schema describes them"),
      },
    },
    async (input: {
      capability: string;
      profile: string;
      connection: string;
      arguments?: Record<string, unknown>;
    }) => {
      const { capability, profile, connection } = input;
      const entry = merged.get(capability);

      // Not in the merged set means not advertised to this caller, which is the
      // same answer discovery gave. Said as "cannot reach" rather than "does not
      // exist", because the two are deliberately indistinguishable from here
      // (ADR-007's "probing must not be an oracle").
      if (!entry) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `This caller cannot reach "${capability}".\n` +
                'Run lanes_tools_search to see what is reachable — a capability that is not ' +
                'connected and one that is not granted look the same from here.',
            },
          ],
          isError: true,
        };
      }

      // The two tools registered here are not capabilities and are not in the
      // merged set, so `entry` above already refuses them. This is the guard for
      // the case where that stops being true: a generic dispatcher that can
      // reach itself is one prompt away from a loop that costs a rate limit.
      if (capability.startsWith('lanes_tools.')) {
        return {
          content: [{ type: 'text' as const, text: 'lanes_tools cannot call itself.' }],
          isError: true,
        };
      }

      const runtime = options.profiles.get(profile);
      const reachable = entry.reachable.get(profile);

      if (!runtime || !reachable) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Profile "${profile}" does not offer ${capability}. Available: ${[...entry.reachable.keys()].join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      // The same refusal `makeHandler` makes, for the same reason: the enums are
      // a union across profiles, so a caller can name a valid profile and a
      // connection belonging to a different one, and routing a `work` account
      // through `personal` would cross exactly the boundary profiles exist to
      // hold.
      if (!reachable.includes(connection)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Connection "${connection}" is not part of profile "${profile}". Available there: ${reachable.join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      const outcome = await runtime.dispatcher.invoke({
        principal: forProfile(options.principal, profile),
        capabilityId: capability,
        connectionKey: connection,
        arguments: input.arguments ?? {},
        ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
      });

      if (!outcome.ok) {
        return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
      }

      if (!isToolResult(outcome.result)) {
        return {
          content: [{ type: 'text' as const, text: `${capability} is not a tool` }],
          isError: true,
        };
      }

      // Text only, unlike `makeHandler`. A `resource_link` has to be rewritten
      // through `resourceLinkRouter` to carry the profile and connection it was
      // produced under, and a link is a follow-up call the caller makes against
      // a *typed* resource tool — so a caller reaching a capability through here
      // gets the text and is told to use the named tool for the rest.
      return {
        content: outcome.result.content.map((block) =>
          block.type === 'text'
            ? { type: 'text' as const, text: block.text }
            : {
                type: 'text' as const,
                text: `[${block.name ?? block.uri}] — call ${toolNameFor(capability)} directly to receive this as a resource link.`,
              },
        ),
        ...(outcome.result.isError ? { isError: true } : {}),
      };
    },
  );
}
