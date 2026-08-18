import { z } from 'zod';

/**
 * The three string shapes the config contract is built out of.
 *
 * Their own file because more than one schema module needs them, and the
 * alternative was either a circular import or a second copy of a regex that
 * governs authorization. A duplicated `credentialRef` that drifted would let a
 * literal secret through in whichever copy was looser.
 */

export const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase letters, digits, and underscores, starting with a letter');

export const credentialRef = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)+$/,
    'must be a credential reference like "gmail/main", not a literal value',
  );

/**
 * `*`, `gmail.*`, `gmail.users.*`, `gmail.users.drafts.send`, `notion.get-comments`.
 *
 * The provider half is ours and stays strict. The capability half is **not**:
 * it comes from an upstream MCP server or an OpenAPI document, and vendors name
 * things however they like — Notion uses hyphens throughout, and an OpenAPI
 * operationId is routinely dotted (`users.drafts.send`). Constraining it would
 * mean refusing to express a policy rule for a tool that demonstrably exists,
 * which is worse than a slightly looser grammar. Dots were rejected here until
 * the HTTP connector shipped, which made `lanes link policy deny
 * gmail.users.drafts.send` — the command `connect` itself prints — impossible
 * to write.
 *
 * A trailing `.*` is the only wildcard, and it may appear at any depth, so
 * `gmail.users.*` narrows without naming every operation. Do not build a policy
 * expression language beyond that.
 */
export const capabilityPattern = z
  .string()
  .regex(
    /^(?:\*|[a-z][a-z0-9_]*\.(?:\*|[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*(?:\.\*)?))$/,
    'must be "*", "gmail.*", "gmail.users.*", or "gmail.users.drafts.send"',
  );
