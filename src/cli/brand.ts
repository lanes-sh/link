/**
 * The Lanes design tokens, and the pieces every page this repository serves is
 * built from.
 *
 * Three surfaces render HTML — the authorization consent screen, the page a
 * connect flow lands on, and the dashboard — and until this file existed each
 * carried its own approximation of the brand. They had drifted: two greens and
 * two ambers that are not tokens at all, nine different alphas standing in for
 * one border colour, a destructive red with a dark variant the token does not
 * have, and the system font stack where Geist belongs.
 *
 * Values are transcribed from https://lanes.sh/design/foundations. The rules
 * they express, which the CSS below encodes rather than restates:
 *
 * - **Gold is the only accent.** "Gold for positive, neutral tokens otherwise."
 *   That is why there is no green here: a connection that works is `positive`,
 *   which is gold, and everything else is one of two neutrals. `--destructive`
 *   is for errors, not for a state that merely needs attention.
 * - **Two weights, 400 and 500.** Nothing else is available in the loaded faces,
 *   so a heavier rule would silently synthesise.
 * - **Lora heads, Geist speaks, Geist Mono for code and eyebrow labels.**
 *
 * `--border`, `--accent-gold` and `--destructive` are constant across themes.
 * Only the five neutrals swap, which is why the dark block below is five lines
 * rather than a second stylesheet.
 */

/**
 * Escape text for an HTML body.
 *
 * `escapeXml` in `connectivity/transports/dav/xml.ts` would do, and `cli` is
 * allowed to import `connectivity` — but a page renderer reaching into a DAV
 * transport for a string function is a dependency nobody would defend. Five
 * lines is cheaper than the coupling.
 *
 * Load-bearing: these pages render a provider's `manifest.name`, and a custom
 * provider supplies that from a YAML file of its own.
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
 * One request for all three faces.
 *
 * `preconnect` to both hosts because the stylesheet and the font files it names
 * are served from different origins, and the second lookup is otherwise not
 * started until the first has parsed.
 */
export const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
  '<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500' +
  '&amp;family=Geist:wght@400;500&amp;family=Lora:wght@400;500&amp;display=swap" rel="stylesheet">';

/** The one-row footer, identical to the one the Lanes API's own pages carry. */
export const FOOTER =
  '<div class="footer"><p>Your unfair advantage in parallel AI coding. ' +
  '<a href="https://lanes.sh/">lanes.sh</a></p></div>';

/**
 * The tokens, and the base every page shares.
 *
 * The background is **painted**, which reverses what these pages used to do.
 * The old note read "nothing is painted" — a transparent body under
 * `color-scheme: light dark` so the browser supplied its own canvas — and it
 * was written to fix a hardcoded `#0d1117` that showed as a black rectangle on
 * a light machine. The design system settles that differently: it names a
 * background for each mode, so the fix is to paint the right one rather than
 * none. `color-scheme` stays, because form controls and scrollbars still need
 * to know which mode they are in.
 */
export const TOKENS = `
:root {
  color-scheme: light dark;
  --background: #EBEAE7;
  --card: #F0EFEC;
  --muted: #E2E1DD;
  --foreground: #171717;
  --muted-foreground: #202329;
  --border: rgba(120,113,108,0.2);
  --accent-gold: #A1845A;
  --destructive: #A06060;
  /* The two tints the badge variants need. Spelled as rgba rather than
     color-mix because the consent screen opens in whatever browser a phone
     happens to use, and both accents are constant across themes anyway. */
  --gold-fill: rgba(161,132,90,0.1);
  --gold-ring: rgba(161,132,90,0.25);
  --destructive-fill: rgba(160,96,96,0.1);
  --destructive-ring: rgba(160,96,96,0.25);
  --sans: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --serif: "Lora", Georgia, "Times New Roman", serif;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #171717;
    --card: #292524;
    --muted: #202329;
    --foreground: #EBEAE7;
    --muted-foreground: #A8A29E;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--sans); font-weight: 400;
       background: var(--background); color: var(--foreground); }
h1, h2, h3 { font-family: var(--serif); font-weight: 500; letter-spacing: -0.01em; margin: 0; }
h1 { font-size: 28px; line-height: 1.3; }
code, .mono { font-family: var(--mono); }
a { color: inherit; }

/* Eyebrow: 11px, uppercase, wide tracking, muted — and mono, which is where the
   design system puts label type. */
.eyebrow { font-family: var(--mono); font-size: 11px; font-weight: 400;
           letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted-foreground);
           opacity: 0.75; }

/* Surfaces are dashed and 10px; controls are 6px; pills are round. */
.surface { background: var(--card); border: 1px dashed var(--border); border-radius: 10px; }

/* The four badge variants, as the design system defines them: gold for
   positive, neutral tokens otherwise, destructive for an error only. The ring
   is an inset shadow so it costs no layout, exactly as \`ring-inset\` does. */
.pill { display: inline-flex; align-items: center; flex: none; white-space: nowrap;
        font-size: 11px; font-weight: 500; letter-spacing: 0.02em;
        padding: 2px 8px; border-radius: 999px; box-shadow: inset 0 0 0 1px var(--border); }
.pill.positive { background: var(--gold-fill); color: var(--accent-gold);
                 box-shadow: inset 0 0 0 1px var(--gold-ring); }
.pill.neutral { background: var(--muted); color: var(--muted-foreground); }
.pill.quiet { background: transparent; color: var(--muted-foreground); opacity: 0.7; }
.pill.negative { background: var(--destructive-fill); color: var(--destructive);
                 box-shadow: inset 0 0 0 1px var(--destructive-ring); }

/* Ghost is the variant every button on these pages is: muted until it is
   wanted, and never gold, because gold is reserved for saying a thing is good. */
.btn { font: inherit; font-size: 12px; font-weight: 500; line-height: 1;
       padding: 6px 9px; border-radius: 6px; cursor: pointer;
       background: transparent; color: var(--muted-foreground);
       border: 1px solid var(--border); }
.btn:hover, .btn:focus-visible { color: var(--foreground); background: var(--muted); }

.footer { margin: 40px 0 0; text-align: center; }
.footer p { margin: 0; font-size: 12px; line-height: 1.5; color: var(--muted-foreground); opacity: 0.75; }
.footer a { text-decoration: underline; }
`.trim();

/**
 * What every page these modules serve loads, and nothing else.
 *
 * The font stylesheet and the faces it names are the only two origins any of
 * them reaches; `default-src 'none'` closes the rest. No `script-src`, because
 * these pages have no script — the dashboard, which has one listener, extends
 * this rather than replacing it.
 */
export const PAGE_CSP =
  "frame-ancestors 'none'; default-src 'none'; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  'font-src https://fonts.gstatic.com';

/**
 * Headers every page here answers with.
 *
 * `frame-ancestors` in both spellings: one of these pages asks for the endpoint
 * token and another lists the owner's accounts, and framing either is the cheap
 * half of a UI-redress attack. The URLs carry a `client_id`, a `redirect_uri`,
 * or a one-time key, none of which belongs in a Referer.
 */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': PAGE_CSP,
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};
