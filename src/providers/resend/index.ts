import { defineProvider } from '#connectivity';

/** Resend registers us at connect time — nothing for an operator to set up. */
export const resend = defineProvider({
  id: 'resend',
  name: 'Resend',
  description: 'Transactional email, domains, and delivery events, via Resend\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.resend.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
