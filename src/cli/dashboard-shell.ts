import { escapeHtml, FOOTER } from './callback-page.ts';

/**
 * The dashboard's chrome: its stylesheet, its one listener, and the document
 * they hang in.
 *
 * Split from `dashboard-page.ts` because the two answer different questions.
 * That file decides what a row says; this one decides what a row looks like and
 * what the response is allowed to load. Neither needs to read the other to be
 * changed, and together they were over the file-size budget — which
 * `src/architecture.test.ts` describes as a prompt to look for the seam rather
 * than a number to raise.
 */

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
       margin: 0; background: transparent; padding: 40px 24px; }
.wrap { width: 100%; max-width: 620px; margin: 0 auto; }
.narrow { text-align: center; padding: 32px 0; }
h1 { font-family: "Lora", Georgia, "Times New Roman", serif; font-size: 28px; font-weight: 500;
     letter-spacing: -0.01em; margin: 0 0 20px; }
h2 { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
     opacity: 0.45; margin: 30px 0 8px; }
.desc { margin: 0 0 12px; font-size: 14px; line-height: 1.6; opacity: 0.7; }
.empty { margin: 0 0 12px; font-size: 14px; line-height: 1.6; opacity: 0.55; }
.switch { display: flex; flex-wrap: wrap; gap: 20px; padding-bottom: 4px; }
.group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.glabel { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.45;
          margin-right: 2px; }
.chip { display: inline-block; padding: 3px 10px; font-size: 13px; border-radius: 999px;
        border: 1px solid rgba(120,113,108,0.35); color: inherit; text-decoration: none; opacity: 0.75; }
.chip:hover { border-color: rgba(120,113,108,0.7); opacity: 1; }
.chip.on { border-color: rgba(120,113,108,0.85); opacity: 1; font-weight: 500; }
.chip.off { border-style: dashed; opacity: 0.45; }

/* One line per item: mark, name, whatever qualifies it, then the button hard
   right. \`min-width: 0\` on the row lets the name ellipsize rather than push
   the button off the end. */
.rows { display: flex; flex-direction: column; }
.row { display: flex; align-items: center; gap: 10px; min-width: 0;
       padding: 7px 10px; border-radius: 8px; }
.row:hover { background: rgba(120,113,108,0.07); }
.glyph { flex: none; display: inline-flex; align-items: center; justify-content: center;
         width: 17px; height: 17px; opacity: 0.75; margin: 0 3px; }
/* The stand-in wants the box the real marks do not: bare letters read as text
   that failed to load, where a brand mark reads as itself. */
.glyph.letters { width: 23px; height: 23px; margin: 0; border-radius: 6px; font-size: 8.5px;
                 font-weight: 600; letter-spacing: 0.02em; opacity: 0.5;
                 border: 1px solid rgba(120,113,108,0.35); }
.name, .key { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name { font-size: 14px; }
.key { font-size: 13.5px; font-weight: 500; }
.account { font-size: 12.5px; opacity: 0.5; min-width: 0; overflow: hidden;
           text-overflow: ellipsis; white-space: nowrap; }
.pill { flex: none; font-size: 10.5px; padding: 1px 8px; border-radius: 999px;
        border: 1px solid currentColor; }
.pill.ok { color: #059669; }
.pill.warn { color: #B45309; }
.pill.off { color: inherit; opacity: 0.45; }

/* Hard right, on every row, so the column of buttons reads as one column.
   Always visible, never revealed on hover: the button is the only way to get
   the command now that the line itself is not on the page, and an affordance
   you have to find by sweeping the mouse is one most readers never find. */
.copy { flex: none; margin-left: auto; font: inherit; font-size: 11px; padding: 3px 9px;
        color: inherit; background: transparent; border: 1px solid rgba(120,113,108,0.35);
        border-radius: 5px; cursor: pointer; opacity: 0.5; }
.row:hover .copy { opacity: 0.8; }
.copy:hover, .copy:focus-visible { opacity: 1; border-color: rgba(120,113,108,0.8); }

/* The two places the command is still the label, so it stays visible. */
.cmd { display: flex; align-items: center; gap: 8px; margin-top: 8px;
       border: 1px solid rgba(120,113,108,0.28); border-radius: 7px; padding: 8px 10px; }
.cmd code { flex: 1; font-size: 12.5px; line-height: 1.5; word-break: break-all; opacity: 0.85; }
.cmd .copy { opacity: 0.7; }
.footer { margin: 40px 0 0; text-align: center; }
.footer p { margin: 0; font-size: 12px; line-height: 1.5; opacity: 0.5; }
.footer a { color: inherit; text-decoration: underline; }
@media (prefers-color-scheme: dark) {
  .pill.ok { color: #34D399; }
  .pill.warn { color: #FBBF24; }
  .row:hover { background: rgba(200,200,200,0.06); }
}
`.trim();

/**
 * The copy button, and nothing else.
 *
 * Inline because a separate file would be the first static asset this
 * repository serves, and one listener is not worth that. It reads the command
 * from a data attribute rather than from the DOM text so that what is copied is
 * exactly what was rendered, whitespace included.
 */
const SCRIPT = `
document.addEventListener('click', function (event) {
  var button = event.target.closest('.copy');
  if (!button || !navigator.clipboard) return;
  navigator.clipboard.writeText(button.dataset.copy).then(function () {
    button.textContent = 'copied';
    setTimeout(function () { button.textContent = 'copy'; }, 1200);
  });
});
`.trim();

export function shell(inner: string, title: string, status: number): Response {
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
</style>
</head>
<body>
<div class="wrap">
${inner}
${FOOTER}
</div>
<script>
${SCRIPT}
</script>
</body>
</html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // This page lists what the owner has connected and to which accounts.
        // Framing it is the cheap half of a UI-redress attack, and nothing here
        // is ever meant to be embedded — refused in both spellings for the same
        // reason `callback-page.ts` refuses it.
        'content-security-policy':
          "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src https://fonts.gstatic.com; script-src 'unsafe-inline'",
        'x-frame-options': 'DENY',
        // The URL may still carry `?k=` in the moment before the redirect lands.
        'referrer-policy': 'no-referrer',
        // Connection keys and account names are not something to leave in a
        // shared browser's back-forward cache.
        'cache-control': 'no-store',
      },
    },
  );
}
