/**
 * What to ask for when a message is being filled in rather than asked for.
 *
 * The gateway fills in a list that came back as identifiers (`server/mcp/expand.ts`),
 * and without this it does so at whatever the vendor returns by default. Gmail's
 * default is `format=full`: every `Received:` hop, the DKIM and ARC headers, and
 * the body as base64. Five of those measured 193,271 characters and overflowed
 * the reply — for a caller who had asked to see what was in their inbox.
 *
 * `metadata` answers that question instead. It carries the envelope headers
 * named here plus `snippet`, which is the preview, and drops the body — so a
 * whole page of mail costs less than one message did, and the row that needs
 * reading in full is one `users.messages.get` away.
 *
 * Two capabilities and not four, because the others cannot reach this code:
 * `threads.list` rows carry three keys and `labels.list` returns whole labels,
 * so `referencesIn` rejects both and no follow-up is ever made. If a vendor
 * change makes either return bare references, adding the line here is the fix.
 *
 * `drafts.get` takes no `metadataHeaders` — the parameter is not in its spec —
 * so `metadata` there returns the full header set. That is cheap for the one
 * message kind that was never delivered, so it has no `Received:` chain.
 *
 * `fields` would compose with this and is deliberately not used. `metadata`
 * already drops the body, which is the whole of the saving, and a second
 * shaping parameter adds a way for the call to fail with a 400 for about a
 * hundred bytes.
 */
export const GMAIL_COMPACT: Record<string, Record<string, unknown>> = {
  'users.messages.get': {
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
  },
  'users.drafts.get': { format: 'metadata' },
};
