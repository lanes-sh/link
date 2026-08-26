import { defineProvider, defineProviderWithCapabilities } from '#connectivity';
import { GMAIL_IDENTITY, GOOGLE_APP, GOOGLE_OAUTH, specPath } from '../shared/oauth.ts';
import { googleServiceAccount } from '../shared/service-account.ts';
import { googleSetup } from '../shared/setup.ts';
import { GMAIL_HOST } from './api.ts';
import { GMAIL_HINTS } from './hints.ts';
import { GMAIL_REDACT } from './redact.ts';
import { gmailSendMessage } from './send.ts';

/**
 * Gmail over the REST API — the one that works for everybody.
 *
 * `gmail-mcp` proxies Google's own MCP server, which is the nicer thing on
 * paper: their tools, their maintenance. It is also gated behind a Workspace
 * Developer Preview that a personal @gmail.com account cannot enrol in, and the
 * failure is silent — consent succeeds, tools/list succeeds, every call returns
 * "The caller does not have permission".
 *
 * So the plain name is the working one. The REST API has no preview gate, no
 * enrolment, and the same scopes; what it costs is that the tool list is
 * generated from an OpenAPI document rather than curated by Google.
 */

/**
 * What the REST provider needs to read, draft, and organise mail.
 *
 * `gmail.modify` is here for organising, and it is not a preference: Gmail has
 * no verb for read-state, spam, or archive. Each one is a label edit on a
 * message — remove `UNREAD`, add `SPAM`, remove `INBOX` — and `modify` is the
 * only scope that permits editing a message's labels. `gmail.labels` sounds
 * narrower and is not a substitute: it governs the label vocabulary, not its
 * application. So the choice is `modify` or no organising at all.
 *
 * It is marked broad in `../shared/scopes.ts` and should stay marked, because it
 * also grants send and trash. What it does not grant is permanent delete — that
 * is `mail.google.com`, which nothing here asks for. Policy is what keeps the
 * granted-but-unwanted verbs unreachable: the token can send, the tool surface
 * cannot, and `lanes link policy deny` narrows it further.
 */
/**
 * `gmail.settings.basic` is here for blocking a sender, and it is the one scope
 * in this list that buys a *kind* of reach the others do not.
 *
 * Adding `SPAM` to a message trains Gmail against that sender and is what the
 * Report-spam button does; it is already reachable under `modify`. Blocking is
 * the other button, and it is a filter — a standing rule, created once, that
 * keeps acting on mail that does not exist yet. `filters.create` and
 * `filters.delete` accept no other scope. (`filters.list` accepts `readonly`,
 * so seeing what exists costs nothing extra; only changing it costs this.)
 *
 * That standing quality is why it is marked broad in `../shared/scopes.ts`
 * rather than waved through as narrower than `modify`. Every other write here
 * acts on a message that already exists, and stops when the session does. A
 * filter with `addLabelIds: ['TRASH']` keeps trashing mail after the token
 * expires and after the connection is disabled — `lanes link policy deny`
 * removes the tool, and cannot uninstall the rule. It is the argument that
 * refuses `messages.delete`, one step removed.
 *
 * What it deliberately does not reach: `delegates.create` and
 * `forwardingAddresses.create` are `gmail.settings.sharing`, so the two
 * settings that silently exfiltrate a mailbox stay out, and a filter's
 * `action.forward` only accepts an address already verified by hand.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

const manifest = defineProvider({
  id: 'gmail',
  name: 'Gmail',
  description:
    'Read, search, send, draft, and organise mail — labels, read-state, spam, and trash — via the Gmail REST API.',
  connector: {
    kind: 'http',
    base_url: GMAIL_HOST,
    // Vendored, not fetched: a spec decides which paths are called with a real
    // mailbox token, and `connect` grants everything a provider discovers.
    openapi: specPath('gmail.v1.json'),
  },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: GOOGLE_APP,
    scopes: GMAIL_SCOPES,
    ...GOOGLE_OAUTH,
    assertion: googleServiceAccount('Gmail', GMAIL_SCOPES, 'required', ['gmail.googleapis.com']),
  },
  // The REST API rather than the MCP server: it answers with the address under
  // scopes we already hold, so labelling a connection costs no extra consent.
  identity: GMAIL_IDENTITY,
  setup: googleSetup('Gmail', GMAIL_SCOPES),
  redact: GMAIL_REDACT,
  hints: GMAIL_HINTS,
  // Named here because an `http` connector otherwise assigns bundles by HTTP
  // method during discovery, and an authored capability is never discovered.
  bundles: [{ name: 'write', capabilities: ['send_message'] }],
});

/**
 * Almost all data, and one capability that has to be code.
 *
 * The exception is sending. Gmail's API takes a whole assembled RFC 2822 message
 * as one base64url field, and no OpenAPI document describes composing one — so the
 * generated tools leave that to the caller, which makes attaching a file
 * impossible in practice rather than merely awkward. `send.ts` says the rest.
 * Everything else about this provider is still the manifest above.
 */
export const gmail = defineProviderWithCapabilities({
  manifest,
  capabilities: [gmailSendMessage],
});
