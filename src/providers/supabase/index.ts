import { defineProvider } from '#connectivity';

/** Supabase registers us at connect time — nothing for an operator to set up. */
export const supabase = defineProvider({
  id: 'supabase',
  name: 'Supabase',
  description: 'Projects, database schema, SQL, edge functions, and docs, via Supabase\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.supabase.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
  /**
   * No identity block, and it is a verified refusal rather than an omission.
   *
   * Supabase's authorization server *is* `api.supabase.com`, so the MCP token
   * is an ordinary Management API one and the endpoint that names a person
   * looked like a free answer. It is not: `GET /v1/profile` refuses that token
   * outright — 401, "does not support oauth access yet" — and it is not a
   * scope, since none is advertised that would cover it. There is no
   * `/v1/user`, `/v1/me`, or userinfo; all three are 404.
   *
   * What OAuth does reach is `/v1/organizations` and `/v1/projects`, and both
   * are collections. A `field` through a collection resolves to whichever
   * element happens to be first, which is arbitrary for anyone in more than one
   * organization and, worse, unstable — a reconnect that resolved a different
   * one would append a row instead of repairing it. That is the failure the
   * account field exists to prevent.
   */
});
