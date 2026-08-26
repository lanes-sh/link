import { escapeHtml, FONTS, FOOTER, PAGE_CSP, PAGE_HEADERS, TOKENS } from './brand.ts';

/**
 * The dashboard's chrome: its layout, its one listener, and the document they
 * hang in.
 *
 * Split from `dashboard-page.ts` because the two answer different questions —
 * that file decides what a row says, this one decides what a row looks like and
 * what the response is allowed to load. Everything shared with the two
 * authorization pages, which is every colour and every face, is in `brand.ts`;
 * what is left here is the one thing this surface does not share with them, a
 * wide list rather than a centred card.
 */

const STYLE = `
body { padding: 40px 24px; }
.wrap { width: 100%; max-width: 620px; margin: 0 auto; }
.narrow { text-align: center; padding: 32px 0; }
h1 { margin: 0 0 20px; }
h2 { margin: 30px 0 8px; }
.desc { margin: 0 0 12px; font-size: 14px; line-height: 1.6; color: var(--muted-foreground); }
.empty { margin: 0 0 12px; font-size: 14px; line-height: 1.6; color: var(--muted-foreground);
         opacity: 0.8; }

/* Profile and target selectors. The current one is not gold: gold says a thing
   is good, and which profile you are looking at is not a verdict. */
.switch { display: flex; flex-wrap: wrap; gap: 20px; padding-bottom: 4px; }
.group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.chip { display: inline-block; padding: 3px 10px; font-size: 13px; border-radius: 999px;
        border: 1px solid var(--border); color: var(--muted-foreground); text-decoration: none; }
.chip:hover { color: var(--foreground); background: var(--muted); }
.chip.on { color: var(--foreground); background: var(--muted); font-weight: 500; }
.chip.off { border-style: dashed; opacity: 0.5; }

/* One line per item: mark, name, whatever qualifies it, then the button hard
   right. \`min-width: 0\` on the row lets the name ellipsize rather than push
   the button off the end. */
.rows { display: flex; flex-direction: column; }
.row { display: flex; align-items: center; gap: 10px; min-width: 0;
       padding: 7px 10px 7px 4px; border-radius: 6px; }
.row:hover { background: var(--muted); }
.glyph { flex: none; display: inline-flex; align-items: center; justify-content: center;
         width: 17px; height: 17px; margin: 0 3px; opacity: 0.85; }
/* The stand-in wants the box the real marks do not: bare letters read as a mark
   that failed to load, where a brand mark reads as itself. */
.glyph.letters { width: 23px; height: 23px; margin: 0; border-radius: 6px; font-size: 8.5px;
                 font-weight: 500; letter-spacing: 0.02em; color: var(--muted-foreground);
                 border: 1px solid var(--border); opacity: 1; }
.name, .key { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name { font-size: 14px; }
.key { font-family: var(--mono); font-size: 13px; }
.account { font-size: 12.5px; color: var(--muted-foreground); opacity: 0.8; min-width: 0;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Always visible, never revealed on hover: the button is the only way to get the
   command now that the line itself is not on the page, and an affordance you
   have to find by sweeping the mouse is one most readers never find. */
.copy { margin-left: auto; opacity: 0.6; }
.row:hover .copy { opacity: 1; }
.copy:hover, .copy:focus-visible { opacity: 1; }

/* The two places the command is still the label, so it stays visible. */
.cmd { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 8px 10px;
       background: var(--card); border: 1px dashed var(--border); border-radius: 10px; }
.cmd code { flex: 1; font-size: 12.5px; line-height: 1.5; word-break: break-all; }
.cmd .copy { opacity: 0.8; margin-left: 0; }
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
${FONTS}
<title>${escapeHtml(title)}</title>
<style>
${TOKENS}
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
        ...PAGE_HEADERS,
        // The shared policy plus the one thing this page has that the others do
        // not: an inline listener, for the copy button.
        'content-security-policy': `${PAGE_CSP}; script-src 'unsafe-inline'`,
        // Connection keys and account names are not something to leave in a
        // shared browser's back-forward cache.
        'cache-control': 'no-store',
      },
    },
  );
}
