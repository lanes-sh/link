/**
 * The two pages a browser reaches on its way through an authorization.
 *
 * `approvalPage` is the consent screen a remote MCP client stops at;
 * `completionPage` is where a provider connect flow lands. For a few seconds
 * each of them is the whole product, so both are the product's own page: the
 * dashed card, the Lora heading, and the shared one-row footer that the Lanes
 * API serves after a workspace invite or an email verification.
 *
 * Everything visual now comes from `brand.ts`. Two decisions this file used to
 * record have been settled the other way by the design system, and are worth
 * naming because both look like regressions otherwise:
 *
 * - **The canvas is painted.** This used to be transparent under
 *   `color-scheme: light dark`, so the browser supplied its own — a fix for a
 *   hardcoded `#0d1117` that read as a black rectangle on a light machine. The
 *   system names a background per mode, so the fix is now to paint the right
 *   one. `color-scheme` stays, for form controls and scrollbars.
 * - **The success mark is gold, not green.** It was lucide's `check` at
 *   `#059669`, chosen to match the tick the Lanes app puts against a connected
 *   integration. The design system is explicit that gold is the only accent and
 *   "gold for positive, neutral tokens otherwise", so the green was the odd one
 *   out rather than the match it was meant to be.
 *
 * What has not changed is that colour is reserved for status and spent nowhere
 * else — not on emphasis, and not on the heading.
 */

import { escapeHtml, FONTS, FOOTER, pageCsp, PAGE_HEADERS, TOKENS } from './brand.ts';

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
 * The card, centred. Everything else is `brand.ts`.
 */
const STYLE = `
body { display: flex; align-items: center; justify-content: center;
       min-height: 100vh; padding: 24px; }
.wrap { width: 100%; max-width: 460px; text-align: center; }
.card { padding: 48px 36px; }
.label { margin: 0 0 6px; font-size: 15px; font-weight: 500; color: var(--muted-foreground); }
h1 { margin: 0 0 18px; }
.detail { margin: 0; font-size: 15px; line-height: 1.6; color: var(--muted-foreground); }
.icon { display: block; margin: 0 auto 18px; color: var(--accent-gold); }
.err h1 { color: var(--destructive); }
`.trim();

/**
 * The success mark, above the label.
 *
 * lucide's `check`, in `--accent-gold` — which is what "gold for positive"
 * means when the positive thing is a connection that now works. It carries no
 * colour of its own; `.icon` sets it, so it follows the token if the token moves.
 *
 * `aria-hidden` because the word underneath is the announcement; a screen reader
 * hearing "Connected" does not also need to hear about a tick.
 */
const ICON =
  '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="28" height="28" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M20 6 9 17l-5-5"/></svg>';

/**
 * Something went wrong, said to the person it went wrong for.
 *
 * This replaces the consent form (ADR-062), and the two are worth contrasting.
 * The form asked a browser on loopback for the endpoint token — the one
 * credential that opened everything — which made it the most valuable thing a
 * hostile local page could reach. Identity now comes from lanes.sh, so the only
 * page this endpoint renders is one that *tells* rather than asks.
 *
 * Rendered as a page rather than returned as text because of who reads it. The
 * important message here is "you signed in, and no profile on this endpoint
 * lists you" — which arrives at a browser, at the end of a sign-in, addressed
 * to somebody who needs to know what to ask their operator for.
 */
export function noticePage(message: string, status: number): Response {
  // Deliberately whole-text-escaped and then split on blank lines: these
  // messages carry a subject and sometimes a command, and neither is markup.
  const body =
    `<h1>Not authorised</h1>` +
    message
      .split('\n\n')
      .map((paragraph) => `<p class="detail">${escapeHtml(paragraph)}</p>`)
      .join('\n');

  return shell(body, 'Not authorised', status, ' err');
}

/**
 * One document, both pages.
 *
 * No script hook any more, and no `form-action` parameter. Both existed for the
 * consent form: it ran an inline listener to disable its own button, and it had
 * to name in its policy the client origin its approval redirected to. Identity
 * moved to lanes.sh (ADR-062) and the form went with it, so the policy narrows
 * back to what it was before — which is the rare direction for a CSP to move
 * and worth saying out loud.
 */
function shell(inner: string, title: string, status: number, cardClass = ''): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONTS}
<title>${escapeHtml(title)}</title>
<style>
${TOKENS}
${STYLE}
${FORM_STYLE}
</style>
</head>
<body>
<div class="wrap">
<div class="card surface${cardClass}">
${inner}
</div>
${FOOTER}
</div>
</body>
</html>`,
    {
      status,
      headers: { ...PAGE_HEADERS, 'content-security-policy': pageCsp({}) },
    },
  );
}

/**
 * What is left of the form styles.
 *
 * `.small` alone: the consent form's field, button and spinner went with the
 * form (ADR-062). Kept as its own constant rather than folded into `STYLE`
 * because the completion page still uses it for the line under the card.
 */
const FORM_STYLE = `
.small { margin-top: 16px; font-size: 12px; color: var(--muted-foreground); opacity: 0.8; }
.small code { font-size: 12px; }
`.trim();

export function completionPage(page: CallbackPage): Response {
  const { heading, label, detail, ok } = page;

  // The tab strip truncates to a few characters, and the word that has to
  // survive that is the outcome — not the name of what was connected.
  const title = label ?? heading;

  const body =
    `${ok ? `${ICON}\n` : ''}` +
    `${label ? `<p class="label">${escapeHtml(label)}</p>\n` : ''}` +
    `<h1>${escapeHtml(heading)}</h1>` +
    `<p class="detail">${escapeHtml(detail)}</p>`;

  // Through the same shell as the consent screen, rather than a second copy of
  // the document. They were already meant to be one page; only the error class
  // on the card differs.
  return shell(body, title, ok ? 200 : 400, ok ? '' : ' err');
}
