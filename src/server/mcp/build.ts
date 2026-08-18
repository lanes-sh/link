import { McpServer } from '@modelcontextprotocol/server';
import { isPrompt, isResource, isTool } from '#connectivity';
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
    },
    // Second argument, not the first: `instructions` is a `ServerOptions` field,
    // and `Implementation` would take it as an unknown extra and drop it from
    // `initialize` without complaining.
    { instructions: serverInstructions(names, merged) },
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
