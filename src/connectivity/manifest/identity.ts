import { z } from 'zod';

/**
 * How to find out *whose* account was just authorised.
 *
 * Without this a config file says `Gmail main2`, which cannot answer the only
 * question anyone asks of a connection list — which mailbox is this? The answer
 * has to come from the provider, because it is the only party that knows, and
 * it has to be declarative, or every vendor costs code again.
 *
 * Three sources cover everything we have met:
 *
 * - `http` — a GET returning JSON, for a vendor whose MCP server exposes no
 *   identity tool. Gmail answers `users/me/profile` with `emailAddress` under
 *   scopes we already hold, so this costs no extra consent.
 * - `tool` — call a capability on the upstream MCP server and read a field of
 *   the result. Linear's `get_workspace` is exactly this.
 * - `connector` — the connector already knows, so ask it. A protocol that
 *   authenticates by username has nothing to probe: the answer is the name the
 *   *server accepted*, which is a stronger claim than the one the operator
 *   typed, and there is no endpoint to GET for it.
 *
 * `field` is a dotted path. Resolution is best-effort by design: a provider with
 * no identity block, or one whose probe fails, falls back to asking the
 * operator. A connection is worth labelling, never worth blocking on.
 */
export const identitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http'),
    url: z.url(),
    /** Dotted path into the JSON body, e.g. `emailAddress` or `user.emailAddress`. */
    field: z.string().min(1),
    /**
     * A second path, shown in brackets, where `field` alone is not unique.
     *
     * Almost no provider needs one: an address identifies a Google or iCloud
     * account globally, and a GitHub login is unique across GitHub. Slack is
     * the exception, because the thing it calls a user is scoped to a
     * workspace — the same person in two workspaces answers `auth.test` with
     * the same `user`, and one account string is how `settleIdentity` decides a
     * connect is a *reconnect*. Without this, connecting a second workspace
     * matches the first and overwrites its credential.
     */
    qualifier: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('tool'),
    tool: z.string().min(1),
    field: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ kind: z.literal('connector') }),
]);

export type IdentityDeclaration = z.infer<typeof identitySchema>;
