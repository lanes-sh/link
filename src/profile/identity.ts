import { z } from 'zod';
import { identifier } from './primitives.ts';

/**
 * Who the owner is, in this profile — the names, addresses, and handles they
 * want used when something is written as them.
 *
 * A profile already says what is *reachable*: connections, credentials, what
 * policy permits. It said nothing about *whose* they are. So an agent composing
 * a message, opening a pull request, or signing off had to infer a name from
 * whatever happened to be in the conversation, and it mixed them across
 * profiles — the work signature on a personal mailbox, the wrong handle in a
 * commit trailer. The information was knowable and simply not written down.
 *
 * Three shapes were possible and only this one is right:
 *
 * - **A list, not a map.** `names: [John, Semin]` cannot say *when* to use
 *   which, and the note is the whole point — an owner with two names has them
 *   for a reason. A flat list of `{kind, value, note}` mirrors `connections`,
 *   which is the other list in this file whose order a reader relies on.
 * - **`kind` is free-form**, any `identifier`. Shipping an enum would mean a
 *   release every time someone wants `linkedin`, `pronouns`, or `signature`,
 *   and there is nothing this file could do with the knowledge that a value is
 *   an email that would be worth that. Rendering is generic and stays generic.
 * - **`note` is prose, not a reference.** Binding an entry to a connection was
 *   the obvious alternative and is a trap: it puts a cross-reference into
 *   `assertReferentialIntegrity`, and then renaming a connection breaks config
 *   *load* — the profile stops opening because a name in a signature moved.
 *   The agent reading "use with the personal mailbox" gets it right without
 *   costing anything the day that mailbox is renamed.
 *
 * Declaration order is meaningful and preserved: the first entry of a kind is
 * the one to reach for absent a reason, and the reader of the YAML sees the same
 * order the agent is told.
 *
 * Not a secret, and worth being explicit about why, because this is the first
 * block in a profile that holds the owner's own data rather than a pointer to
 * it. A name and an address are disclosed by the first message of any mailbox
 * this endpoint serves; withholding them here while serving the mailbox would
 * be theatre. What is refused is a *credential* pasted into a value — a token
 * beginning `ghp_` in a `github` entry trips `secret-detection.ts` like anything
 * else in this file, which is that check working rather than getting in the way.
 */
export const identityEntrySchema = z.object({
  /** `name`, `email`, `github` — or anything else the owner finds useful. */
  kind: identifier,
  value: z.string().min(1),
  /**
   * When this one applies, in the owner's words.
   *
   * Optional, and usually absent on the only entry of its kind: a profile with
   * one address needs no note explaining which address to use. It earns its
   * place the moment there are two.
   */
  note: z.string().min(1).optional(),
});

export const identitySchema = z.array(identityEntrySchema);

export type IdentityEntry = z.infer<typeof identityEntrySchema>;
