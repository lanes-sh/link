/**
 * Setting an agent up to use this endpoint.
 *
 * A barrel beside the directory, matching `operate.ts` and `owner.ts` and for
 * the same reason: `main.ts` binds `./mcp.ts`, and Bun does not resolve that to
 * `mcp/index.ts`.
 *
 * Five files, because "set up an agent" turned out to be two jobs with
 * different rules (ADR-016):
 *
 *   harnesses  which agents we know, and what each will accept
 *   register   running the harness's own registration command
 *   assets     writing the documents no harness has a command for
 *   list       what is set up, and what has drifted
 *   stdio      serving the client that spawns us instead of connecting
 */

export { skillDocument } from './mcp/assets.ts';
export { harnessCommands } from './mcp/harnesses.ts';
export { mcpList } from './mcp/list.ts';
export { mcpAdd, type McpAddOptions } from './mcp/register.ts';
export { mcpStdio } from './mcp/stdio.ts';
export { installInstructions, type InstallInstructionsFlags } from './mcp/onboarding.ts';
