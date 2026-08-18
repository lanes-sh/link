/**
 * Where Gmail is, in the two shapes it comes in.
 *
 * One file so the manifest's `base_url` and the authored send capability cannot
 * drift apart — `tools.test.ts` asserts the manifest matches the vendored spec's
 * server, and a second copy of the host is how a change satisfies that test while
 * breaking the hand-written call beside it.
 */

export const GMAIL_HOST = 'https://gmail.googleapis.com';

/** What the generated tools use, and what an ordinary JSON call goes to. */
export const GMAIL_API = `${GMAIL_HOST}/gmail/v1/users/me`;

/**
 * The media-upload host, for a message too large to carry as a JSON string.
 *
 * A separate path rather than a query parameter: Google exposes uploads under
 * `/upload/...`, and posting a large body to the ordinary endpoint does not fail
 * loudly so much as get slower and then stop working.
 */
export const GMAIL_UPLOAD = `${GMAIL_HOST}/upload/gmail/v1/users/me`;

/**
 * The largest message Gmail will send, from its discovery document
 * (`users.messages.send`, `maxSize: 36700160`).
 *
 * Note this is the *send* ceiling; `messages.import` allows 150 MiB. So it is a
 * limit on putting mail into the world, not on storing it, which is why it is
 * named for sending.
 */
export const GMAIL_MAX_MESSAGE_BYTES = 36_700_160;

/**
 * Above this, submit through the upload host instead of as a JSON field.
 *
 * Google's guidance calls `uploadType=media` the route for files over roughly
 * this size, and the arithmetic agrees: `raw` is base64url inside a JSON string,
 * so a message near the 35 MiB ceiling would be ~47 MiB of text in a request body
 * and would meet a generic limit long before Gmail's own.
 */
export const GMAIL_JSON_LIMIT_BYTES = 5 * 1024 * 1024;
