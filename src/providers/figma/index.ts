import { defineProvider } from '#connectivity';

/** Figma registers us at connect time — nothing for an operator to set up. */
export const figma = defineProvider({
  id: 'figma',
  name: 'Figma',
  description: 'Files, designs, components, and Dev Mode context, via Figma\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.figma.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
