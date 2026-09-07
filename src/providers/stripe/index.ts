import { defineProvider } from '#connectivity';

/** Stripe registers us at connect time — nothing for an operator to set up. */
export const stripe = defineProvider({
  id: 'stripe',
  name: 'Stripe',
  description: 'Payments, customers, invoices, subscriptions, and balances, via Stripe\'s official MCP server.',
  keywords: ['payment', 'invoice', 'subscription', 'customer', 'billing'],
  connector: { kind: 'mcp', endpoint: 'https://mcp.stripe.com' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
