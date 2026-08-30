import { defineProvider } from '#connectivity';

/** PayPal registers us at connect time — nothing for an operator to set up. */
export const paypal = defineProvider({
  id: 'paypal',
  name: 'PayPal',
  description: 'Invoices, orders, payments, subscriptions, and disputes, via PayPal\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.paypal.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
