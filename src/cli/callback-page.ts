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

export interface ApprovalPage {
  /** What is asking. A client's self-reported name, or a stand-in. */
  readonly client: string;
  /** Where the code would be sent. The part of the request that cannot be faked. */
  readonly redirectHost: string;
  /**
   * The same destination as a CSP source, so the browser will follow the
   * redirect this form's approval ends in rather than blocking it.
   */
  readonly formAction?: string;
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
<p class="small"><code>lanes link outputs --show --workspace ${escapeHtml(page.target)}</code></p>`;

  return shell(body, 'Authorise', page.retry ? 401 : 200, '', {
    script: SUBMIT_SPINNER,
    ...(page.formAction ? { formAction: [page.formAction] } : {}),
  });
}

/**
 * What runs while the approval is in flight.
 *
 * Approving is a round trip to an authorization server, and until it returns the
 * page looks exactly as it did before the click — so the honest reading is that
 * nothing happened, and the second click is the one that produces a duplicated
 * request. The button disables itself, which is the part that matters; the
 * spinner is what says why.
 *
 * The cost is real and worth naming: this is the one page that asks for the
 * endpoint token, and an inline listener means its policy admits inline script.
 * It is the minimum that does the job — one listener, no interpolation, nothing
 * read from the page — and the alternative, a static file, is an asset pipeline
 * this repository does not have.
 */
const SUBMIT_SPINNER = `
document.querySelector('form').addEventListener('submit', function (event) {
  var button = event.currentTarget.querySelector('.go');
  button.classList.add('busy');
  button.disabled = true;
});
`.trim();

function shell(
  inner: string,
  title: string,
  status: number,
  cardClass = '',
  policy: { readonly script?: string; readonly formAction?: readonly string[] } = {},
): Response {
  const script = policy.script ?? '';
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
${script ? `<script>\n${script}\n</script>` : ''}
</body>
</html>`,
    {
      status,
      headers: {
        ...PAGE_HEADERS,
        'content-security-policy': pageCsp({
          ...(script ? { script: true } : {}),
          ...(policy.formAction ? { formAction: policy.formAction } : {}),
        }),
      },
    },
  );
}

const FORM_STYLE = `
.field { width: 100%; margin: 20px 0 12px; padding: 11px 13px; font: inherit; font-size: 15px;
         color: inherit; background: var(--background); border: 1px solid var(--border);
         border-radius: 6px; }
.field:focus { outline: none; border-color: var(--accent-gold); }
.go { width: 100%; padding: 11px 13px; font: inherit; font-size: 15px; font-weight: 500;
      color: var(--foreground); background: transparent; border: 1px solid var(--border);
      border-radius: 6px; cursor: pointer; }
.go:hover { background: var(--muted); }
.small { margin-top: 16px; font-size: 12px; color: var(--muted-foreground); opacity: 0.8; }
.small code { font-size: 12px; }
.err-text { color: var(--destructive); }

/* The button, mid-flight. The label goes transparent rather than away, so the
   button keeps the width it had and the card does not reflow under the cursor. */
.go.busy { color: transparent; position: relative; pointer-events: none; }
.go.busy::after { content: ''; position: absolute; inset: 0; margin: auto;
                  width: 15px; height: 15px; border-radius: 50%;
                  border: 2px solid var(--border); border-top-color: var(--foreground);
                  animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
/* Monochrome deliberately: gold says a thing turned out well, and a request in
   flight has not turned out yet. */
@media (prefers-reduced-motion: reduce) {
  .go.busy::after { animation-duration: 2.4s; }
}
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
