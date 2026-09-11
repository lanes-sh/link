import { forProfile, mayReach } from '#auth';
import { isTool, isToolResult } from '#connectivity';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  type Filters,
  SEARCH_RESULT,
  searchAnswer,
} from './search-index.ts';
import { EXPAND, type ExpandArgument, expandIfReferences } from './expand-result.ts';
import { validate } from './validate.ts';
import { SURFACE_TOOL_NAMES, toolNameFor } from './naming.ts';
import {
  accountsByProfile,
  mergeCapabilities,
  type BuildServerOptions,
  type MergedCapability,
} from './visibility.ts';

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



export function registerSearchSurface(
  server: McpServer,
  options: BuildServerOptions,
  // Built once by `buildMcpServer` and handed down.
  //
  // This used to call `mergeCapabilities` itself, so the whole policy sweep —
  // every profile, every capability, `allowedConnections` per candidate
  // connection — ran twice on every single request: once for the registration
  // loop and once for this closure, for the same answer. Optional so the
  // function still stands alone in a test.
  catalogue?: Map<string, MergedCapability>,
): void {
  const merged = catalogue ?? mergeCapabilities(options);
  // **Filtered, like every other enum this server advertises.** Built from the
  // whole map, these two schemas named every profile the endpoint served to a
  // caller no member list names — the only place a profile name still leaked
  // after ADR-060, because `mergeCapabilities` filters what it returns and this
  // read the map beside it. Dispatch refused the call either way; what was
  // disclosed was that the profile is there to ask about (ADR-079).
  const profiles = [...options.profiles.keys()].filter((name) =>
    mayReach(options.principal, name),
  );

  server.registerTool(
    SURFACE_TOOL_NAMES[0]!,
    {
      title: 'Search every tool this endpoint can reach',
      // Reading a catalogue this endpoint already holds. Nothing leaves the
      // process, nothing changes, and asking twice gives the same answer — so
      // this is the one tool on the surface a client can safely stop asking
      // permission for, and saying so is most of what makes a search cheap.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      // Declared because the answer is already structured and a client is
      // entitled to validate it: the specification says a server MUST conform to
      // an output schema it publishes, and has nothing to say about one
      // returning structured content with no schema to check it against.
      outputSchema: SEARCH_RESULT,
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
        // Every filter below narrows an answer that was already built from what
        // this caller may reach. None of them can widen it, and naming
        // something unreachable returns nothing rather than saying it exists.
        provider: z
          .string()
          .optional()
          .describe('Only this provider, when you already know which account answers.'),
        profile: z.enum(profiles as [string, ...string[]]).optional().describe('Only this profile.'),
        connection: z.string().optional().describe('Only capabilities this account can serve.'),
        readOnly: z
          .boolean()
          .optional()
          .describe('Only capabilities that read. Use when looking something up, never to make a write safe — this filters the answer and grants nothing.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('How many to explain in full. Three by default; ten is the most.'),
      },
    },
    async (input: {
      query: string;
      provider?: string | undefined;
      profile?: string | undefined;
      connection?: string | undefined;
      readOnly?: boolean | undefined;
      limit?: number | undefined;
    }) => {
      const { query, ...rest } = input;
      const filters: Filters = rest;
      const accounts = accountsByProfile(options);

      // Both, deliberately, and off one ranking. The text is what a model reads;
      // the structured copy is what a client acts on without a regular
      // expression. The spec asks for a serialized form in the text block too,
      // and here the prose is the more useful thing to put there.
      const { text, structured } = searchAnswer(query, merged, options.surface, filters, accounts);

      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: structured as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    SURFACE_TOOL_NAMES[1]!,
    {
      title: 'Invoke any tool this endpoint can reach',
      // The gateway cannot say what it is about to do, because that depends on
      // the capability named in the call. A hint is a property of a tool and
      // this tool is every tool, so the only honest posture is the cautious
      // one — which is the cost `surface: crunched` pays here: routing provider
      // calls through one name means none of them can carry their own.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
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
        expand: EXPAND,
      },
    },
    async (input: {
      capability: string;
      profile: string;
      connection: string;
      arguments?: Record<string, unknown>;
      expand?: ExpandArgument | undefined;
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

      // A capability that is not a tool is refused here rather than dispatched.
      //
      // It used to be checked on the way *out*: the entry was found, the call
      // ran, a rate-limit unit was spent, an audit row was written and the
      // upstream was possibly reached — and only then did the result turn out
      // not to be a tool result. A resource is not callable, and saying so
      // costs nothing before the fact and a round trip after it.
      if (entry.discovered === undefined && (!entry.capability || !isTool(entry.capability))) {
        return {
          content: [{ type: 'text' as const, text: `${capability} is not a tool` }],
          isError: true,
        };
      }

      // Arguments are checked against the schema this endpoint advertised for
      // this capability, before anything leaves the process.
      //
      // The typed tools have always had this: the SDK compiles their input
      // schema at registration and refuses a malformed call itself. Reaching
      // the same capability through the gateway had nothing — `arguments` is an
      // open record — so a misspelled field travelled to the vendor, cost a
      // network round trip and an audit row, and came back as whatever error
      // that vendor writes. Under `surface: crunched` every provider call takes
      // this path, so it was every call.
      //
      // The failure is returned as a tool execution error with the schema
      // attached, because the specification is explicit that clients should
      // feed those back to the model to self-correct. The next turn is then a
      // corrected call rather than another search.
      const invalid = validate(capability, entry, input.arguments ?? {});
      if (invalid) return invalid;

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

      // A list that came back as bare identifiers is filled in before it is
      // returned, so reading one thing does not cost two calls. Every condition
      // is strict — see `expand.ts` — and a list already holding whole records
      // fails them and is left alone, which is what happens to almost every
      // provider here.
      const filled = await expandIfReferences({
        capability,
        result: outcome.result,
        asked: input.expand,
        merged,
        listArguments: input.arguments ?? {},
        dispatch: async (capabilityId, args) =>
          runtime.dispatcher.invoke({
            principal: forProfile(options.principal, profile),
            capabilityId,
            connectionKey: connection,
            arguments: args,
            ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
          }),
      });
      if (filled) return filled;

      // Text only, unlike `makeHandler`. A `resource_link` has to be rewritten
      // through `resourceLinkRouter` to carry the profile and connection it was
      // produced under, and a link is a follow-up call the caller makes against
      // a *typed* resource tool — so a caller reaching a capability through here
      // gets the text and is told to use the named tool for the rest.
      //
      // Under `crunched` there is no named tool to be told about, so the
      // message says what is actually true rather than naming one the client
      // cannot call. This is the one thing the mode genuinely costs, and it is
      // recorded in ADR-076 rather than papered over.
      const linkAdvice =
        options.surface === 'crunched'
          ? 'this endpoint does not advertise its typed tools, so the resource link cannot be handed back through here'
          : `call ${toolNameFor(capability)} directly to receive this as a resource link`;

      return {
        content: outcome.result.content.map((block) =>
          block.type === 'text'
            ? { type: 'text' as const, text: block.text }
            : {
                type: 'text' as const,
                text: `[${block.name ?? block.uri}] — ${linkAdvice}.`,
              },
        ),
        ...(outcome.result.isError ? { isError: true } : {}),
      };
    },
  );
}
