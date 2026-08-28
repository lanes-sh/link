import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { approvalPage, completionPage } from './callback-page.ts';

/**
 * Every page this repository serves, held to the design system.
 *
 * The sweep that produced `brand.ts` found four surfaces that had each drifted
 * separately: two greens and two ambers that are not tokens, nine alphas
 * standing in for one border colour, a destructive red with a dark variant the
 * token does not have, and the system font stack where Geist belongs. None of
 * it was visible from any one file, which is why this test reads them together.
 *
 * The rule is deliberately blunt — outside `brand.ts` a colour literal is a
 * violation, whatever its value — because the failure mode is not a wrong shade,
 * it is a right-looking shade that no longer moves when the token does.
 */

const SRC = new URL('.', import.meta.url).pathname;

/** The eight tokens, plus the four tints derived from the two constant accents. */
const DECLARED = [
  '#EBEAE7',
  '#171717',
  '#F0EFEC',
  '#292524',
  '#E2E1DD',
  '#202329',
  '#A8A29E',
  '#A1845A',
  '#A06060',
  'rgba(120,113,108,0.2)',
  'rgba(161,132,90,0.1)',
  'rgba(161,132,90,0.25)',
  'rgba(160,96,96,0.1)',
  'rgba(160,96,96,0.25)',
];

/** Every module that contributes CSS to a served page. */
const SURFACES = ['callback-page.ts'];

const read = (name: string) => readFile(join(SRC, name), 'utf8');

/** Blank comments, keeping line numbers, so prose about a colour is not one. */
function codeOnly(source: string): string {
  let inBlock = false;
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (inBlock) {
        if (trimmed.includes('*/')) inBlock = false;
        return '';
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlock = true;
        return '';
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
      return line.replace(/\/\/.*$/, '');
    })
    .join('\n');
}

const COLOUR = /#[0-9A-Fa-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)/g;

describe('colour comes from the tokens', () => {
  test('no page module spells a colour of its own', async () => {
    const violations: string[] = [];

    for (const name of SURFACES) {
      for (const [index, line] of codeOnly(await read(name)).split('\n').entries()) {
        for (const hit of line.match(COLOUR) ?? []) {
          violations.push(`${name}:${index + 1} spells ${hit} — use a var(--token)`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('brand.ts declares only the values the system publishes', async () => {
    const found = codeOnly(await read('brand.ts')).match(COLOUR) ?? [];
    const undeclared = [...new Set(found)].filter((value) => !DECLARED.includes(value));

    // A new value here means the design system grew one, or somebody invented
    // one. The first is a two-line change; the second is the thing this catches.
    expect(undeclared).toEqual([]);
  });

  test('every token the system publishes is actually used', async () => {
    // The other direction: a token declared and never referenced is one the
    // pages are quietly not honouring.
    const brand = await read('brand.ts');
    for (const token of [
      '--background',
      '--card',
      '--muted',
      '--foreground',
      '--muted-foreground',
      '--border',
      '--accent-gold',
      '--destructive',
    ]) {
      expect(brand).toContain(`var(${token})`);
    }
  });
});

describe('type comes from the tokens', () => {
  test('only the two weights the loaded faces have', async () => {
    // Normal and medium. A heavier rule does not fail loudly — the browser
    // synthesises a bolder face, which looks like a design decision.
    const violations: string[] = [];

    for (const name of [...SURFACES, 'brand.ts']) {
      for (const [index, line] of codeOnly(await read(name)).split('\n').entries()) {
        const hit = line.match(/font-weight:\s*(\d{3})/);
        if (hit && hit[1] !== '400' && hit[1] !== '500') {
          violations.push(`${name}:${index + 1} sets font-weight ${hit[1]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('no page module spells a font stack of its own', async () => {
    // Naming `var(--mono)` on a code element is the token being used. Naming
    // `-apple-system, ...` is a page deciding for itself, which is how three
    // surfaces ended up on the system stack while the brand moved to Geist.
    const violations: string[] = [];

    for (const name of SURFACES) {
      for (const [index, line] of codeOnly(await read(name)).split('\n').entries()) {
        const hit = line.match(/font-family:\s*([^;]+)/);
        if (hit && !hit[1]!.trim().startsWith('var(--')) {
          violations.push(`${name}:${index + 1} spells ${hit[1]!.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe('what a browser actually receives', () => {
  const PAGES: ReadonlyArray<[string, Response]> = [
    ['completion', completionPage({ heading: 'Connected', detail: '.', ok: true })],
    [
      'approval',
      approvalPage({
        client: 'A client',
        redirectHost: 'example.com',
        fields: {},
        action: '/authorize',
        retry: false,
        target: 'local',
      }),
    ],
  ];

  for (const [name, response] of PAGES) {
    test(`${name} carries the tokens and all three faces`, async () => {
      const body = await response.text();

      expect(body).toContain('--accent-gold: #A1845A');
      expect(body).toContain('prefers-color-scheme: dark');
      expect(body).toContain('background: var(--background)');
      // One request, three families: Lora heads, Geist speaks, Geist Mono for
      // code and eyebrow labels.
      expect(body).toContain('family=Geist+Mono');
      expect(body).toContain('family=Geist:');
      expect(body).toContain('family=Lora');
    });

    test(`${name} loads the two font origins and nothing else`, async () => {
      const csp = response.headers.get('content-security-policy') ?? '';

      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain('https://fonts.googleapis.com');
      expect(csp).toContain('https://fonts.gstatic.com');
      // Script is allowed exactly where there is one: the consent screen has a
      // submit spinner, and the page a connect flow lands on has nothing.
      expect(csp.includes('script-src')).toBe(name !== 'completion');
    });
  }
});
