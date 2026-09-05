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
 *
 * **A `field` must name one value, never a collection.** `pluck` walks into the
 * first element of an array on the way past, so a path through a list resolves
 * to whoever happens to be first and reads exactly like a working probe. That
 * is the mistake `notion-get-users` would have made — the integration bot leads
 * the list, not the person — and a confident wrong label is worse than the
 * question it saves.
 */

/**
 * A second path, shown in brackets, where `field` alone is not unique.
 *
 * Almost no provider needs one: an address identifies a Google or iCloud
 * account globally, and a GitHub login is unique across GitHub. The exceptions
 * are the vendors whose "user" is scoped to a tenant — the same person in two
 * Slack workspaces answers `auth.test` with the same `user`, and the same
 * person in two Notion workspaces is the same email. One account string is how
 * `settleIdentity` decides a connect is a *reconnect*, so without this,
 * connecting a second tenant matches the first and overwrites its credential.
 */
const qualifier = z.string().min(1).optional();

export const identitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http'),
    url: z.url(),
    /** Dotted path into the JSON body, e.g. `emailAddress` or `user.emailAddress`. */
    field: z.string().min(1),
    /**
     * Sent alongside the credential.
     *
     * For the APIs that answer nothing without one: Notion refuses a request
     * carrying no `Notion-Version`, and it is not the only vendor that pins its
     * version in a header rather than the path. The credential is added by the
     * probe and cannot be set here — a manifest naming its own `authorization`
     * would be a second, unaudited way to send one.
     */
    headers: z.record(z.string(), z.string()).optional(),
    qualifier,
  }),
  z.object({
    kind: z.literal('tool'),
    tool: z.string().min(1),
    field: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
    qualifier,
  }),
  z.object({ kind: z.literal('connector') }),
]);

export type IdentityDeclaration = z.infer<typeof identitySchema>;
