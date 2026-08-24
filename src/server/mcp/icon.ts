import type { Icon } from '@modelcontextprotocol/server';

/**
 * The mark the endpoint reports to a client that renders one.
 *
 * SEP-973 (protocol revision 2025-11-25) added `icons` to `Implementation`, so
 * `initialize.result.serverInfo` can carry the server's own branding rather
 * than leaving every client to generate a letter avatar from the name.
 *
 * **Nothing renders this in Claude today.** claude.ai shows custom connectors
 * with a generated avatar and ignores `serverInfo.icons` entirely — as does
 * Claude Code. That is a client gap, tracked in anthropics/claude-ai-mcp#152,
 * where the reporter ruled out every server-side route in turn: `icons` with an
 * https src, `icons` with a data URI, `/favicon.ico` and `/favicon.png` at the
 * origin, and an HTML `<link rel="icon">`. None are fetched.
 *
 * It is here anyway because the cost is a few kilobytes on `initialize` and the
 * alternative is a release the day the gap closes. Other clients already
 * honour the field.
 */

/**
 * The tile: the published mark's own geometry, used verbatim and not inset.
 *
 * These are the numbers from the published file — a 737.28 square at a
 * sub-pixel offset inside a 738 × 739 box, with `rx="150"` corners. The tile is
 * both the ground and the mask, which is what makes the stripes stop exactly
 * where the rounded square does.
 *
 * **The mark is not inset, and that is a deliberate reversal.** An earlier
 * version held it a tenth of the box clear of the edge, reasoning that a
 * circular avatar crop would otherwise take the rounded-square silhouette. It
 * does take it — but what the margin actually produced was a dark ring inside
 * the circle with the stripes shrunk away from it, which reads as a small mark
 * badly placed rather than as a mark whose corners were cropped. Filling the
 * box is the better trade in both shapes: cropped to a circle the stripes run
 * edge to edge, and left square the silhouette is there anyway.
 */
const TILE = { x: 0.360107, y: 0.859375, size: 737.28, radius: 150 } as const;

/** The box the published file declares, which the tile sits inside. */
const WIDTH = 738;
const HEIGHT = 739;

const GROUND = '#121214';
const INK = '#ffffff';

/**
 * The icon: the published Lanes mark, filling its box, on its own dark ground.
 *
 * This is the mark lanes.sh serves as `/icon-light.svg` and `/icon-dark.svg`.
 * It is *not* the glyph beside "Any MCP client" in the README diagram: that one
 * is the Model Context Protocol's own logo, sitting in the client column next
 * to the Anthropic and OpenAI marks, and shipping it here would have branded
 * this endpoint with someone else's mark.
 *
 * Copied into `src/` rather than read from disk or fetched: the Dockerfile
 * (`src/deployments/gcp/Dockerfile`) copies `package.json`, the lockfile,
 * `bunfig.toml` and `src/` and nothing else, so a runtime read of a checked-in
 * asset outside `src/` works from a checkout and returns nothing from every
 * deployed target — the half of the bug that only shows up in production. A
 * fetch would be worse: an icon that depends on the network resolving is an
 * icon that is sometimes missing.
 *
 * **The ground is painted, not inherited.** The published pair leaves the gaps
 * between the stripes transparent and lets the page supply the ground, which is
 * right for a favicon on lanes.sh and wrong here: a client draws an icon on a
 * surface this file knows nothing about, and transparent gaps mean the mark is
 * a different thing on each one and invisible on some. Painting `#121214`
 * behind the stripes is what makes the result the same icon everywhere, and it
 * is why there is one entry below rather than two.
 *
 * The twenty-four stripes are generated rather than pasted. In the published
 * file they are an exact arithmetic progression — same step on both axes, the
 * export's own rounding never off by more than 0.02 units, which is under a
 * thousandth of a pixel at 32px — so a loop says what twenty-four near-
 * identical lines only imply.
 */
function mark(): string {
  const stripes: string[] = [];
  for (let i = 0; i < 24; i += 1) {
    const x = (345.141 + i * 203.2425).toFixed(3);
    const y = (-4382.52 + i * 203.2425).toFixed(3);
    stripes.push(
      `<rect x="${x}" y="${y}" width="143.715" height="6661.17"` +
        ` transform="rotate(45 ${x} ${y})" fill="${INK}" />`,
    );
  }

  // One rect shape, spelled once and used twice: as the ground the stripes are
  // painted over, and as the mask that stops them at its edge. Written apart
  // they are two places to change a corner radius and one place to forget.
  const tile = `x="${TILE.x}" y="${TILE.y}" width="${TILE.size}" height="${TILE.size}" rx="${TILE.radius}"`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">`,
    '<title>Lanes Link</title>',
    `<rect ${tile} fill="${GROUND}" />`,
    // The rounded square is a mask rather than a drawn shape, which is what
    // makes the stripes stop where they do. Its id has to be stable but not
    // unique — the icon is its own `data:` document, so nothing else is in
    // scope to collide with it.
    `<mask id="tile" maskUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}">`,
    `<rect ${tile} fill="#fff" />`,
    '</mask>',
    `<g mask="url(#tile)">${stripes.join('')}</g>`,
    '</svg>',
  ].join('');
}

/**
 * Base64 rather than percent-encoding, and `Buffer` rather than `btoa`.
 *
 * Both forms are legal in a `data:` URI and the percent-encoded one is smaller
 * and readable in a log, but every example in the spec and every client that
 * has shipped support reads base64 — this is not the field to be clever in.
 *
 * `Buffer.from(…, 'utf8')` for the reason `src/connectivity/auth/basic/index.ts`
 * gives: `btoa` throws above U+00FF and mangles what it does not throw on.
 * Nothing above ASCII is in the mark today, but the failure mode of the day
 * something is would be a corrupt icon rather than an error.
 */
function dataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/**
 * One entry, and deliberately no `theme`.
 *
 * `theme` says which UI a client should pick this icon *for*, so it is a claim
 * that there is another one to pick instead. The icon carries its own ground
 * and looks the same on either, and two identical entries labelled `light` and
 * `dark` would be metadata describing a variation that does not exist. If a
 * theme-specific mark is ever wanted, that is the point at which the field
 * earns its place.
 *
 * `sizes: ['any']` is what the spec spells for a scalable icon. SVG is a SHOULD
 * for clients and PNG a MUST, so a client could honour `icons` and still skip
 * this one — a rasterised entry is the fix for that, and it can wait until a
 * client we care about needs it, because a PNG blob checked in here is one
 * nobody can regenerate from a clean checkout.
 */
export const SERVER_ICONS: Icon[] = [
  { src: dataUri(mark()), mimeType: 'image/svg+xml', sizes: ['any'] },
];
