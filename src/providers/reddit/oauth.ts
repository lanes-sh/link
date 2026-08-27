/**
 * The Reddit client, and why it is the operator's rather than ours.
 *
 * Every other pre-registered provider here reaches for the broker ADR-028
 * built: one client Lanes operates, so nobody visits a console. That is the
 * right default and it is the wrong answer for Reddit, for a reason particular
 * to how Reddit meters access.
 *
 * Reddit's rate limit is a hundred queries a minute *per OAuth client id* —
 * not per user, not per token. A shared client would pool every install of this
 * program into one bucket, so the limit would be reached by strangers and the
 * failure would arrive as somebody else's traffic. An operator registering
 * their own gets their own hundred, which is the whole budget for one person
 * and nowhere near it for the next.
 *
 * The cost is a console visit, which is what the broker exists to avoid. It is
 * worth paying once here because the alternative degrades with every new user,
 * and a shared limit is not a thing a later change could unpick.
 */
export const REDDIT_APP = 'reddit';

/**
 * How this program names itself to Reddit.
 *
 * Reddit asks callers to identify themselves and throttles the default agent
 * hardest — a client that does not set one is treated as a scraper, which
 * surfaces as sporadic 429s rather than as a refusal anybody can read. Nothing
 * else in this repository sets a `User-Agent`, so `connector.headers` is what
 * carries it.
 *
 * Reddit's documented format ends with the author's handle. That is omitted
 * deliberately: this file is public, a handle is a real identifier, and
 * `architecture.test.ts` refuses one anywhere a reader can see. A descriptive
 * name and a URL satisfy what the throttle actually looks for.
 */
export const REDDIT_USER_AGENT = 'lanes-link/0.3 (+https://lanes.sh/link)';

/**
 * Where the browser comes back to, named to Reddit exactly as written.
 *
 * Reddit matches `redirect_uri` byte for byte, and `connect` normally listens
 * on whatever port the kernel hands out — so a URL registered in the console
 * months earlier could never match. Declaring it pins the listener to this
 * port instead. See `cli/oauth.ts` and ADR-045.
 *
 * The port is high and otherwise unused, which is the only property it needs:
 * nothing else in this program listens here, and the operator types the same
 * string into Reddit's form.
 */
export const REDDIT_REDIRECT_URI = 'http://127.0.0.1:8765/callback';

/**
 * What the browser grant asks for.
 *
 * `identity` and `read` carry the reads; `submit` posts and comments; `edit`,
 * `vote`, `save`, and `flair` cover what an author does to their own content
 * afterwards. `mysubreddits` is what lists the subreddits this account follows.
 *
 * Absent on purpose: `privatemessages`, `history`, and every `mod*` scope.
 * Nothing vendored needs them, and a scope on the consent screen that no tool
 * can use is a grant asked for and never spent.
 */
export const REDDIT_SCOPES = [
  'identity',
  'read',
  'submit',
  'edit',
  'vote',
  'save',
  'flair',
  'mysubreddits',
] as const;

/** Resolve a vendored spec beside this folder. */
export function specPath(name: string): string {
  return new URL(`./specs/${name}`, import.meta.url).pathname;
}
