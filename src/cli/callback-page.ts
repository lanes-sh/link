/**
 * The page the browser lands on when a connect flow ends.
 *
 * It is the only HTML this repository serves to a human, and for a few seconds
 * it is the whole product — so it is the product's own page rather than a
 * bespoke one. The design is lifted from the pages the Lanes API serves after
 * someone authorises something (the workspace invite and the email
 * verification): an outline-only card, a Lora heading, native text softened
 * with opacity, and the shared one-row footer.
 *
 * Two decisions are worth keeping:
 *
 * - **Nothing is painted.** `color-scheme: light dark` plus a transparent
 *   background means the browser supplies its own canvas, so the page is
 *   correct in either mode without a theme switch, a media query per colour, or
 *   a preference to read. It replaced a hardcoded `#0d1117`, which was a black
 *   rectangle on a light machine.
 * - **Colour is reserved for status.** Not for emphasis, and not for the
 *   heading — a green *word* said nothing the word "Connected" did not, and
 *   that is why it went. A check is different: it is the glyph the Lanes app
 *   already puts against a connected integration, so a reader arriving from the
 *   app meets the mark they left it with. Both outcomes carry one now, the
 *   check on success and the red heading on failure, and nothing else does.
 *
 * Lora is fetched from Google Fonts, as the API pages do; the fallback stack
 * carries the page on a machine with no network, which is the state a failed
 * authorisation is sometimes in.
 */

export interface CallbackPage {
  /** The focal line, set in Lora. A provider name, or the outcome itself. */
  readonly heading: string;
  /** The small line above it — "Connected" over the name of what was. */
  readonly label?: string;
  /** What the reader should do next. */
  readonly detail: string;
  readonly ok: boolean;
}

/**
 * Escape text for an HTML body.
 *
 * `escapeXml` in `connectivity/transports/dav/xml.ts` would do, and `cli` is
 * allowed to import `connectivity` — but a page renderer reaching into a DAV
 * transport for a string function is a dependency nobody would defend. Five
 * lines is cheaper than the coupling.
 *
 * This is load-bearing: `heading` carries a provider's `manifest.name`, and a
 * custom provider supplies that from a YAML file of its own.
 *
 * Exported because `dashboard-page.ts` renders the same values into the same
 * kind of page. A second copy of an escaper is a second thing to get wrong.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Harmonised with the Lanes API's public pages, which are themselves harmonised
 * with the transactional emails — same dashed card, same Lora, same footer, so
 * the end of a connect flow reads as the same product as the invite that
 * preceded it.
 */
const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
       display: flex; align-items: center; justify-content: center;
       min-height: 100vh; margin: 0; background: transparent; padding: 24px; }
.wrap { width: 100%; max-width: 460px; text-align: center; }
.card { background: transparent; border: 1px dashed rgba(120,113,108,0.35); border-radius: 10px;
        padding: 48px 36px; }
.label { margin: 0 0 6px; font-size: 15px; font-weight: 500; letter-spacing: 0.01em; opacity: 0.6; }
h1 { font-family: "Lora", Georgia, "Times New Roman", serif; font-size: 28px; font-weight: 500;
     letter-spacing: -0.01em; line-height: 1.3; margin: 0 0 18px; }
.detail { margin: 0; font-size: 15px; line-height: 1.6; opacity: 0.75; }
.icon { display: block; margin: 0 auto 18px; color: #059669; }
.footer { margin: 24px 0 0; }
.footer p { margin: 0; font-size: 12px; line-height: 1.5; opacity: 0.5; }
.footer a { color: inherit; text-decoration: underline; }
.err h1 { color: #A06060; }
@media (prefers-color-scheme: dark) {
  .err h1 { color: #C08080; }
  .icon { color: #34D399; }
}
`.trim();

/** The one-row footer below the card, identical to the one the API pages carry. */
export const FOOTER =
  '<div class="footer"><p>Your unfair advantage in parallel AI coding. ' +
  '<a href="https://lanes.sh/">lanes.sh</a></p></div>';

/**
 * The success mark, above the label.
 *
 * The glyph and the emerald are the Lanes app's, so a connected provider looks
 * the same wherever it is reported — lucide's `check` at #059669, lightened to
 * #34D399 on a dark canvas because the darker green does not survive it.
 *
 * `aria-hidden` because the word underneath is the announcement; a screen
 * reader hearing "Connected" does not also need to hear about a tick.
 */
const ICON =
  '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="28" height="28" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M20 6 9 17l-5-5"/></svg>';

export interface ApprovalPage {
  /** What is asking. A client's self-reported name, or a stand-in. */
  readonly client: string;
  /** Where the code would be sent. The part of the request that cannot be faked. */
  readonly redirectHost: string;
  /** Hidden fields carrying the authorization request through the POST. */
  readonly fields: Readonly<Record<string, string>>;
  readonly action: string;
  /** A previous attempt presented the wrong token. */
  readonly retry: boolean;
  /** The target this endpoint runs as, so the hint below names the right store. */
  readonly target: string;
}

/**
 * The one screen a remote client's authorization stops at.
 *
 * Same card as the page above, because it is the same product and the reader
 * arrived here from a connector rather than from a terminal. What it asks for is
 * the endpoint token — the string `lanes link outputs` prints — because that is
 * already the proof of being the owner and inventing a second one would mean
 * inventing a password to go with it.
 *
 * The hint names the target rather than leaving it out. Credentials are
 * per-target, and the reader runs that command in a shell resolving a target of
 * its own — `local` by default, which is the one store a deployed endpoint's
 * token is never in. Omitting it sends them to fetch the wrong secret, and
 * `outputs` mints a fresh one when that store is empty rather than saying so.
 *
 * `autocomplete="off"` and `type="password"` are not theatre: this form is
 * submitted in whatever browser the phone opened, and a token remembered by a
 * shared browser is a token in the hands of whoever borrows the phone.
 */
export function approvalPage(page: ApprovalPage): Response {
  const hidden = Object.entries(page.fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n');

  // The name is self-reported and the host is not, so the host is what the
  // reader is asked to recognise. Registration is open by design, which means
  // anything can call itself anything — but an impostor still has to nominate
  // somewhere for the code to go, and that is on the screen.
  const body = `
${page.retry ? '<p class="label err-text">That token was not accepted.</p>\n' : ''}<h1>Authorise ${escapeHtml(page.client)}?</h1>
<p class="detail">It will be sent back to <strong>${escapeHtml(page.redirectHost)}</strong>, and will be able to reach every profile this endpoint serves, within the policy each one declares.</p>
<form method="post" action="${escapeHtml(page.action)}">
${hidden}
<input class="field" type="password" name="token" placeholder="Endpoint token" autocomplete="off" autofocus required>
<button class="go" type="submit">Approve</button>
</form>
<p class="detail small">Printed by <code>lanes link outputs --show --target ${escapeHtml(page.target)}</code>.</p>`;

  return page.retry ? shell(body, 'Authorise', 401) : shell(body, 'Authorise', 200);
}

function shell(inner: string, title: string, status: number): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500&amp;display=swap" rel="stylesheet">
<title>${escapeHtml(title)}</title>
<style>
${STYLE}
${FORM_STYLE}
</style>
</head>
<body>
<div class="wrap">
<div class="card">
${inner}
</div>
${FOOTER}
</div>
</body>
</html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // One of these pages asks for the endpoint token in a password field.
        // Framing it is the cheap half of a UI-redress attack, and nothing here
        // is ever meant to be embedded — so refuse it in both spellings, since
        // `frame-ancestors` is the one that is actually specified and
        // `X-Frame-Options` is the one older browsers obey.
        'content-security-policy': "frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        // The URL carries a `client_id` and a `redirect_uri`; neither belongs in
        // a Referer sent to whatever the page links out to.
        'referrer-policy': 'no-referrer',
      },
    },
  );
}

const FORM_STYLE = `
.field { width: 100%; margin: 20px 0 12px; padding: 11px 13px; font: inherit; font-size: 15px;
         color: inherit; background: transparent; border: 1px solid rgba(120,113,108,0.45);
         border-radius: 7px; }
.field:focus { outline: none; border-color: rgba(120,113,108,0.9); }
.go { width: 100%; padding: 11px 13px; font: inherit; font-size: 15px; font-weight: 500;
      color: inherit; background: transparent; border: 1px solid rgba(120,113,108,0.55);
      border-radius: 7px; cursor: pointer; }
.go:hover { border-color: rgba(120,113,108,0.95); }
.small { margin-top: 14px; font-size: 12px; opacity: 0.55; }
.small code { font-size: 12px; }
.err-text { color: #A06060; opacity: 1; }
@media (prefers-color-scheme: dark) { .err-text { color: #C08080; } }
`.trim();

export function completionPage(page: CallbackPage): Response {
  const { heading, label, detail, ok } = page;

  // The tab strip truncates to a few characters, and the word that has to
  // survive that is the outcome — not the name of what was connected.
  const title = escapeHtml(label ?? heading);

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500&amp;display=swap" rel="stylesheet">
<title>${title}</title>
<style>
${STYLE}
</style>
</head>
<body>
<div class="wrap">
<div class="card${ok ? '' : ' err'}">
${ok ? `${ICON}\n` : ''}${label ? `<p class="label">${escapeHtml(label)}</p>\n` : ''}<h1>${escapeHtml(heading)}</h1>
<p class="detail">${escapeHtml(detail)}</p>
</div>
${FOOTER}
</div>
</body>
</html>`,
    { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
