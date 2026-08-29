import { defineProvider } from '#connectivity';

/** Prisma registers us at connect time — nothing for an operator to set up. */
export const prisma = defineProvider({
  id: 'prisma',
  name: 'Prisma',
  description: 'Postgres databases, schema, and migrations, via Prisma\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.prisma.io/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
