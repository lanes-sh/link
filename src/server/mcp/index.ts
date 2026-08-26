/**
 * The MCP surface.
 *
 * Six files, each answering one question:
 *
 *   visibility  what this principal may see — policy, applied once
 *   naming      how a capability id is spelled on the wire
 *   schema      how a vendor's JSON Schema is made safe to publish
 *   routing     how the profile and connection reach a resource or a prompt
 *   instructions  what the endpoint says it is for, before any tool is called
 *   tools / resources / prompts   how each capability kind is registered
 *   build       the loop that puts them together
 *
 * It was one 685-line file, and the seam that mattered was invisible in it:
 * everything in `visibility` decides *what* is exposed and everything else
 * decides *how*. A discovery leak can only come from the first, which is now
 * one file with one entry point.
 */

export { buildMcpServer } from './build.ts';
export { serverInstructions } from './instructions.ts';
export { SERVER_NAME, capabilityIdForToolName, toolNameFor } from './naming.ts';
export { scopeResourceUri } from './routing.ts';
export { sanitizeSchema } from './schema.ts';
export {
  mergeCapabilities,
  oneProfile,
  visibleCapabilities,
  visibleToolCount,
  type BuildServerOptions,
  type ConnectionState,
  type MergedCapability,
  type ProfileRuntime,
} from './visibility.ts';
