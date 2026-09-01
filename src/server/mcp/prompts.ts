import { forProfile } from '#auth';
import { clientLabelFrom } from './client-info.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isPromptResult } from '#connectivity';
import { toolNameFor } from './naming.ts';
import { resolveScope } from './routing.ts';
import { describeWithConnections, type BuildServerOptions, type MergedCapability } from './visibility.ts';

/**
 * Prompts — the owner's own procedures, surfaced as slash commands.
 *
 * Unlike a resource, a prompt *does* have arguments, so routing goes in them —
 * ADR-001 rather than ADR-006's URI workaround. Both are optional and default
 * when there is only one candidate, because a prompt's arguments are typically
 * filled in by a person choosing a slash command, and making them type two
 * routing strings to reach their only account would be a poor trade for
 * consistency.
 */
export function registerPrompt(
  server: McpServer,
  id: string,
  entry: MergedCapability,
  capability: Extract<NonNullable<MergedCapability['capability']>, { kind: 'prompt' }>,
  options: BuildServerOptions,
): void {
  const profiles = [...entry.reachable.keys()];
  const connections = [...new Set([...entry.reachable.values()].flat())];

  const shape: Record<string, z.ZodType> = {};

  for (const argument of capability.arguments ?? []) {
    const declared = z.string().describe(argument.description);
    shape[argument.name] = argument.required ? declared : declared.optional();
  }

  shape['profile'] = z
    .string()
    .optional()
    .describe(`Which profile to act within: ${profiles.join(', ')}. Omit if there is one.`);
  shape['connection'] = z
    .string()
    .optional()
    .describe(`Which configured account: ${connections.join(', ')}. Omit if there is one.`);

  server.registerPrompt(
    toolNameFor(id),
    {
      ...(capability.title ? { title: capability.title } : {}),
      description: describeWithConnections(capability.description, entry.reachable),
      argsSchema: z.object(shape),
    },
    async (args: Record<string, unknown>, extra?: unknown) => {
      const { profile, connection, ...rest } = args;
      const scope = resolveScope(entry, profile, connection);
      if ('error' in scope) throw new Error(scope.error);

      const label = clientLabelFrom(extra) ?? options.clientLabel;

      const outcome = await options.profiles.get(scope.profile)!.dispatcher.invoke({
        principal: forProfile(options.principal, scope.profile),
        capabilityId: id,
        connectionKey: scope.connectionKey,
        arguments: rest,
        ...(label ? { clientLabel: label } : {}),
      });

      // A prompt has no `isError` to carry a refusal in, so a denial is a
      // protocol error. That is the honest mapping: there is no partial prompt
      // to hand back, and the message still says why.
      if (!outcome.ok) throw new Error(outcome.message);
      if (!isPromptResult(outcome.result)) throw new Error(`${id} did not return a prompt`);

      return {
        messages: outcome.result.messages.map((message) => ({
          role: message.role,
          content: { type: 'text' as const, text: message.text },
        })),
      };
    },
  );
}
