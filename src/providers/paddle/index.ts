import { defineProvider } from '#connectivity';

/** Paddle registers us at connect time — nothing for an operator to set up. */
export const paddle = defineProvider({
  id: 'paddle',
  name: 'Paddle',
  description: 'Products, prices, subscriptions, and transactions, via Paddle\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.paddle.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
