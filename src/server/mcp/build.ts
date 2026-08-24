import { McpServer } from '@modelcontextprotocol/server';
import { isPrompt, isResource, isTool } from '#connectivity';
import { SERVER_ICONS } from './icon.ts';
import { serverInstructions } from './instructions.ts';
import { SERVER_NAME } from './naming.ts';
import { registerPrompt } from './prompts.ts';
import { registerResource } from './resources.ts';
import { registerDiscoveredTool, registerLocalTool } from './tools.ts';
import { mergeCapabilities, type BuildServerOptions } from './visibility.ts';

/**
 * Building the MCP surface for one principal.
 *
 * Every registration below is downstream of `mergeCapabilities`, which has
 * already applied policy — so this loop never decides what a caller may see, it
 * only decides how each surviving capability is spelled in the protocol.
 */
export function buildMcpServer(options: BuildServerOptions): McpServer {
  const names = [...options.profiles.keys()];

  // One evaluation, two consumers. `mergeCapabilities` runs policy over every
  // capability on every connection, and the instructions describe exactly the
  // set that gets registered below — computing it twice would be the same
  // answer at twice the cost, and two answers the day they drift.
  const merged = mergeCapabilities(options);

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: options.version ?? '0.0.0',
      title: `Lanes Link — ${names.join(', ')}`,
      // First argument, and this is the half of the pairing below that is easy
      // to get wrong in the other direction: `icons`, `description` and
      // `websiteUrl` are `Implementation` fields that SEP-973 added, so they
      // belong here and would be dropped from `ServerOptions`.
      //
      // `description` is `package.json`'s, and the test holds the two equal
      // rather than trusting a copy to stay one. It is the whole endpoint being
      // described, not this connection, so it does not name the profiles the
      // way `title` does.
      description: 'A self-hosted MCP gateway for your accounts, memory, skills, and secrets',
      websiteUrl: 'https://github.com/lanes-sh/link',
      icons: SERVER_ICONS,
    },
    // Second argument, not the first: `instructions` is a `ServerOptions` field,
    // and `Implementation` would take it as an unknown extra and drop it from
    // `initialize` without complaining.
    {
      instructions: serverInstructions(names, merged),
      // Declared `false` because it is false, and the SDK defaults it to `true`.
      //
      // `listChanged` is a promise to send `notifications/tools/list_changed`
      // when the surface changes. This endpoint cannot keep it: it is stateless
      // streamable HTTP, so there is no stream to deliver a notification on and
      // this very server instance is discarded once the response is written.
      // Nothing in `src/` sends one, and nothing can.
      //
      // Leaving the default on is not a harmless inaccuracy. A client that
      // believes it will be told has no reason to ask again, so it keeps the
      // list it captured when it first connected — and the surface here grows
      // every time an account is connected (ADR-029). That combination cost a
      // connector registered before `connect` ran its whole tool list: it held
      // the two setup tools for as long as it lived, and no refresh replaced
      // them, because the refresh was an `initialize` that never went on to ask
      // for `tools/list`.
      //
      // Saying `false` costs a re-list per session and buys a surface that is
      // never stale. Prompts and resources carry the identical default and the
      // identical inability, so they are answered here too.
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
      },
    },
  );

  for (const [id, entry] of merged) {
    // Discovered first: an upstream MCP server or an OpenAPI document supplies
    // the schema, and there is no local capability object to inspect.
    if (entry.discovered) {
      registerDiscoveredTool(server, id, entry, options);
      continue;
    }

    const capability = entry.capability;
    if (!capability) continue;

    if (isTool(capability)) registerLocalTool(server, id, entry, capability, options);
    else if (isResource(capability)) registerResource(server, id, entry, capability, options);
    else if (isPrompt(capability)) registerPrompt(server, id, entry, capability, options);
  }

  return server;
}
