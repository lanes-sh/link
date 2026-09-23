import { randomBytes } from 'node:crypto';
import type { ProviderContext } from '#connectivity';
import { GMAIL_API, GMAIL_JSON_LIMIT_BYTES, GMAIL_UPLOAD } from './api.ts';

/**
 * What `send_message` says to Gmail itself.
 *
 * The requests the transport would have made if an OpenAPI document could
 * describe composing a message: finding the thread a reply belongs in, handing
 * the message over, and sending a draft by id. Apart from `send.ts` for the
 * reason `imap/send.ts` is apart from the IMAP capabilities — that file is the
 * tool, and this is the part that is actually Gmail.
 *
 * One rule holds for every request the capability makes, and it is the one each
 * transported call gets for free: a refusal is handed to `verify` before it is
 * reported, so a token the vendor refused is distrusted rather than resent for
 * the rest of the hour. `call` is where that happens, for the requests here and
 * for `attachment.ts` reading a mailbox attachment. It used to be written out
 * once per request, and the copy in `attachment.ts` was the one that skipped it.
 */

/** The connection's own credential path and reply check, which every request here goes through. */
export interface Channel {
  readonly authorize: (request: Request) => Promise<Request>;
  readonly fetch: typeof globalThis.fetch;
  readonly context: ProviderContext;
}

/**
 * The Gmail thread holding the message a reply answers — or `undefined` when
 * this mailbox holds no such message, and there is no conversation to join.
 *
 * Gmail's own document names three conditions for filing a message in a
 * thread: the `threadId` on the message supplied, `References` and
 * `In-Reply-To` set, and a matching subject. The headers alone meet one of
 * them. A reply sent with them and no thread carries everything a recipient's
 * client threads by, and still arrives in the sender's own mailbox as a
 * conversation of one.
 *
 * Looked up rather than asked for. `in_reply_to` already promised to thread the
 * reply, and a `thread_id` argument beside it would be a second thing a caller
 * has to know to pass, which is the same omission one step further out.
 *
 * `rfc822msgid:` is Gmail's search operator for that header, and the id goes in
 * bare, as in Google's own example. `URLSearchParams` rather than a template,
 * because Gmail's Message-IDs carry `+` and `=` and an unencoded `+` is a
 * space: the search would miss and say nothing. `includeSpamTrash` because the
 * list leaves both out by default, and a reply to a message in either is still
 * a reply to it.
 *
 * Two limits, both chosen. The id is not quoted: Google's example gives it bare
 * and documents no quoting for this operator, and guessing at one risks every
 * ordinary id to rescue the rare one holding a brace or a parenthesis, which
 * would miss and be sent as a new conversation, saying so. And the first match
 * is taken: a Message-ID names one message, and a mailbox holding it in two
 * threads — an import run twice — has two conversations with an equal claim.
 */
export async function threadFor(messageId: string, channel: Channel): Promise<string | undefined> {
  const query = new URLSearchParams({
    q: `rfc822msgid:${messageId}`,
    maxResults: '1',
    includeSpamTrash: 'true',
  });

  const found = await call(
    channel,
    `${GMAIL_API}/messages?${query}`,
    { headers: { accept: 'application/json' } },
    { read: true, refused: 'Gmail refused the search for the message being replied to' },
  );

  const messages = found['messages'];
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  const threadId =
    first !== null && typeof first === 'object' ? (first as { threadId?: unknown }).threadId : undefined;

  return typeof threadId === 'string' ? threadId : undefined;
}

/**
 * Hand the assembled message to Gmail.
 *
 * Two routes, chosen by size. A small message goes as base64url in a JSON field,
 * which is the ordinary endpoint and the overwhelmingly common case. A large one
 * goes to the upload host with the raw MIME as a part of its own, which is what
 * lifts the ceiling from "what fits in a JSON string" to Gmail's own 35 MiB.
 *
 * The resource is built once and both routes carry it: inside the JSON beside
 * `raw`, or as the upload's first part. That is what a large reply was missing.
 * The upload used to be `uploadType=media`, which has nowhere to put a resource
 * at all, so the thread a small reply now names could not travel with a big one.
 */
export async function submit(
  input: {
    readonly raw: Uint8Array;
    readonly draftOnly: boolean;
    readonly draftId: string | undefined;
    readonly threadId: string | undefined;
  } & Channel,
): Promise<Record<string, unknown>> {
  const { raw, draftOnly, draftId, threadId } = input;
  const large = raw.byteLength > GMAIL_JSON_LIMIT_BYTES;

  // Revising is a `PUT` at the draft's own address; the other two are a `POST`
  // at a collection. The upload host takes the same path either way, so size
  // still chooses the host and nothing else.
  const revising = draftId !== undefined;
  const path = revising
    ? `/drafts/${encodeURIComponent(draftId)}`
    : draftOnly
      ? '/drafts'
      : '/messages/send';

  // A draft nests the message, whether it is being created or replaced; only a
  // straight send carries it at the top level.
  const message: Record<string, unknown> = threadId === undefined ? {} : { threadId };
  const resource = (fields: Record<string, unknown>) =>
    draftOnly || revising ? { message: fields } : fields;

  const { url, body, contentType } = large
    ? { url: `${GMAIL_UPLOAD}${path}?uploadType=multipart`, ...related(resource(message), raw) }
    : {
        url: `${GMAIL_API}${path}`,
        body: JSON.stringify(resource({ ...message, raw: Buffer.from(raw).toString('base64url') })),
        contentType: 'application/json',
      };

  return call(
    input,
    url,
    {
      method: revising ? 'PUT' : 'POST',
      headers: { 'content-type': contentType, accept: 'application/json' },
      body,
    },
    { read: false, refused: 'Gmail refused the message' },
  );
}

/**
 * Send a draft that already exists, by id.
 *
 * Always small — the body is one identifier — so there is no upload-host branch
 * here even when the draft it names carries 30 MiB. The bytes were already
 * handed over by the `PUT` that preceded this, and so was the thread.
 */
export async function sendDraft(
  input: { readonly draftId: string } & Channel,
): Promise<Record<string, unknown>> {
  return call(
    input,
    `${GMAIL_API}/drafts/send`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: input.draftId }),
    },
    { read: false, refused: 'Gmail refused to send the draft' },
  );
}

/** Gmail answers with its own id; a draft nests the message inside. */
export function messageIdOf(body: Record<string, unknown>): string | null {
  const id = body['id'];
  if (typeof id === 'string' && !('message' in body)) return id;

  const message = body['message'];
  if (message !== null && typeof message === 'object') {
    const nested = (message as { id?: unknown }).id;
    if (typeof nested === 'string') return nested;
  }

  return typeof id === 'string' ? id : null;
}

/**
 * The conversation Gmail filed the message in, read off its own answer.
 *
 * Reported rather than inferred from what was asked for, because a `threadId`
 * asked for is not a thread joined: Gmail files the message there only when all
 * three of its conditions hold, and a subject that does not match is enough to
 * start a new conversation instead. A draft nests it, as it nests the id.
 */
export function threadIdOf(body: Record<string, unknown>): string | null {
  const message = body['message'];
  const nested =
    message !== null && typeof message === 'object'
      ? (message as { threadId?: unknown }).threadId
      : undefined;
  const threadId = nested ?? body['threadId'];

  return typeof threadId === 'string' ? threadId : null;
}

/**
 * A resource and its message as one `multipart/related` body, for the upload host.
 *
 * The shape Google documents for `messages.send`: a JSON part, then the message
 * as `message/rfc822`. Single-request rather than resumable, though Google
 * suggests resumable for large files: the message is composed whole in memory
 * and capped at 35 MiB before it gets here, so an interrupted upload has nothing
 * to resume from that composing it again would not rebuild. Resumable would add
 * a session to keep and a second request to fail, and save nothing.
 *
 * The boundary is checked against the message rather than trusted to be
 * unlikely, because a boundary that occurs inside a part ends that part there
 * (RFC 2046 §5.1.1). One `Uint8Array`, so the request carries the
 * `Content-Length` Google's upload example shows.
 */
function related(
  resource: Record<string, unknown>,
  raw: Uint8Array,
): { body: Uint8Array; contentType: string } {
  const message = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);

  let boundary: string;
  do {
    boundary = `lanes_${randomBytes(16).toString('hex')}`;
  } while (message.includes(boundary));

  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(resource)}\r\n` +
      `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(head.byteLength + raw.byteLength + tail.byteLength);
  body.set(head);
  body.set(raw, head.byteLength);
  body.set(tail, head.byteLength + raw.byteLength);

  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

/**
 * One request, and what a refusal of it means for the credential behind it.
 *
 * Every refusal is handed to `verify`. What differs is whether the request is
 * made again when `verify` answers `{ retry: true }`, which it does when it has
 * stopped trusting a token and can issue another. A read is: repeating it on a
 * fresh token is the same read, and the http transport does exactly that for
 * every generated tool. A write is not. A send refused with a 401 may still have
 * been delivered, and deciding to repeat it is not this layer's to make — the
 * connection is repaired for the call after this one instead.
 *
 * A retried refusal is verified too, as the transport does, because a second
 * 401 on a reissued token is the only evidence anywhere that the grant itself
 * has ended, and it exists once, here.
 *
 * Handed the parts rather than a `Request`, because a retry needs a second
 * request, authorised afresh, and a `Request` whose body has been sent cannot
 * be sent again. It also means the call's abort signal is attached here, once,
 * rather than by every request remembering to.
 */
export async function call(
  channel: Channel,
  url: string,
  init: RequestInit,
  options: { readonly read: boolean; readonly refused: string },
): Promise<Record<string, unknown>> {
  const { signal } = channel.context;
  const request = () => channel.authorize(new Request(url, { ...init, ...(signal ? { signal } : {}) }));

  let response = await channel.fetch(await request());

  if (!response.ok) {
    const outcome = await verify(channel.context, response);
    if (options.read && outcome?.retry) {
      // Drained before it is dropped, so the refused reply does not hold its
      // connection open until something collects it.
      await response.text();
      response = await channel.fetch(await request());
      if (!response.ok) await verify(channel.context, response);
    }
  }

  const text = await response.text();
  if (!response.ok) throw new Error(`${options.refused} with ${response.status}: ${text}`);

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Hand a refusal to the connection's reply check.
 *
 * Cloned, because the body is still to be read here and a response cannot be
 * cloned once it has been. Cast as the http transport does: the fetch types and
 * the global Response disagree about `headers`, and the verifier reads neither.
 */
function verify(context: ProviderContext, refused: Response) {
  return context.verify?.(refused.clone() as unknown as Response);
}
