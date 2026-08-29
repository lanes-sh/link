import { defineProvider } from '#connectivity';

/** Storyblok registers us at connect time — nothing for an operator to set up. */
export const storyblok = defineProvider({
  id: 'storyblok',
  name: 'Storyblok',
  description: 'Stories, components, assets, and spaces, via Storyblok\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.storyblok.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
