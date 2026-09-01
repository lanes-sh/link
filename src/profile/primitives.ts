import { z } from 'zod';

/**
 * The string shapes the config contract is built out of.
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

/**
 * A browser origin, exactly — scheme, host, and port, with nothing after it. Or
 * `*`, which is what an absent list means anyway and is accepted so that saying
 * it explicitly is not an error.
 *
 * Checked by round trip rather than by a regex, because `URL` already knows what
 * an origin is and the failure this catches is a trailing slash or a path that
 * looks harmless and matches nothing: a browser sends `Origin: https://x.example`
 * and a configured `https://x.example/` would compare unequal, silently refusing
 * the origin its owner believed they had allowed.
 */
export const browserOrigin = z.string().refine(
  (value) => {
    if (value === '*') return true;
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  },
  'must be "*" or an origin with no trailing slash or path, e.g. "https://chat.example"',
);

/**
 * `<provider>.<connection>` — how a grant names what it governs.
 *
 * One string rather than two fields, because it is one string everywhere else
 * it appears: the `connection` argument an agent passes, the audit event, the
 * `setup_overview` listing, and the refusal a mismatched pairing produces.
 * Splitting it in the config alone would mean every reader joins it back
 * together.
 */
export const connectionRef = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_]*$/,
    'must be "<provider>.<connection>", e.g. "gmail.personal"',
  );

/**
 * Who a profile is delegated to: `lanes:<subject>` (ADR-060).
 *
 * The prefix is load-bearing twice over, and the second reason is the one that
 * would otherwise be found the hard way. A Lanes subject is a 28-character
 * mixed-case alphanumeric string — which is exactly what `secret-detection.ts`
 * refuses as a high-entropy blob, so a bare one could not be written into a
 * profile at all. The colon takes the value out of `OPAQUE_TOKEN`'s character
 * class, so saying which identity provider vouched for the subject and being
 * storable are the same decision rather than an exemption list.
 *
 * A pasted credential still cannot be smuggled in here: it does not match this
 * pattern either, which is what makes the fix a narrowing rather than a hole.
 */
export const subjectRef = z
  .string()
  .regex(/^lanes:[A-Za-z0-9]{6,64}$/, 'must be "lanes:<subject>", as written by lanes auth login');
