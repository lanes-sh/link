import { describe, expect, test } from 'bun:test';
import { desktop, settingsUrl } from './desktop.ts';

/**
 * The link, and the two ways it refuses.
 *
 * The file this replaced tested one thing — that a deployed target was refused
 * before `openRuntime` opened its adapters. That refusal went with the served
 * page (ADR-053): this command resolves nothing, so there is no ordering left
 * to get wrong. What is worth pinning instead is the string itself, because it
 * is a contract with a repository this one cannot see.
 */

/** Captured stdout, and the writes restored however the body exits. */
async function captured(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    await body();
  } finally {
    process.stdout.write = original;
  }
  return lines;
}

describe('the link', () => {
  test('is the page id the Lanes app registers', () => {
    // Spelled out rather than composed, deliberately. `integrations-link` is
    // `SETTINGS_PAGE_IDS` in the app's `src/settings/nav.ts`, and the app opens
    // Settings on its current page rather than refusing an id it does not have
    // — so a rename there degrades silently here. This literal and the matching
    // test in that repository are the only two things holding the pair
    // together.
    expect(settingsUrl({})).toBe('lanes://settings?page=integrations-link');
  });

  test('LANES_LINK_APP_SCHEME reaches a debug or stage build', () => {
    // macOS routes a scheme to exactly one bundle, so a local build of the app
    // is unreachable without naming the scheme it registered.
    expect(settingsUrl({ LANES_LINK_APP_SCHEME: 'lanes-dev' })).toBe(
      'lanes-dev://settings?page=integrations-link',
    );
  });

  test('an empty override falls back rather than producing "://"', () => {
    // `||`, not `??`. An unset variable in a shell arrives as the empty string,
    // and `://settings?page=…` is not a URL anything can open.
    expect(settingsUrl({ LANES_LINK_APP_SCHEME: '' })).toBe(
      'lanes://settings?page=integrations-link',
    );
  });
});

describe('--print', () => {
  test('writes the link alone, and opens nothing', async () => {
    let opened = 0;
    const lines = await captured(() =>
      desktop(
        { print: true },
        {
          env: {},
          platform: 'linux',
          open: async () => {
            opened++;
            return true;
          },
        },
      ),
    );

    // One line, and only the URL on it, so `open "$(lanes link desktop
    // --print)"` is a working shell idiom.
    expect(lines.join('')).toBe('lanes://settings?page=integrations-link\n');
    expect(opened).toBe(0);
  });

  test('answers on a platform the app does not ship for', async () => {
    // Ahead of the platform refusal on purpose: printing is what a machine
    // with no desktop wants, and it costs nothing to answer it there.
    const lines = await captured(() =>
      desktop({ print: true }, { env: {}, platform: 'win32', open: async () => false }),
    );

    expect(lines.join('')).toContain('lanes://settings');
  });
});

describe('refusals', () => {
  test('names the platform when the app does not run on it', async () => {
    const attempt = desktop({}, { env: {}, platform: 'linux', open: async () => true });

    // The URL is in the message: there is nothing this command can do on Linux,
    // and the next-best thing is showing what it would have opened.
    await expect(attempt).rejects.toThrow(/macOS-only, and this is linux/);
    await expect(attempt).rejects.toThrow(/lanes:\/\/settings\?page=integrations-link/);
  });

  test('says the app is missing rather than reporting success', async () => {
    // `open` exits non-zero when nothing is registered for the scheme, and that
    // exit code is the whole reason this command awaits its spawn instead of
    // reusing the fire-and-forget opener in `oauth.ts`.
    const attempt = desktop({}, { env: {}, platform: 'darwin', open: async () => false });

    await expect(attempt).rejects.toThrow(/not installed/);
    await expect(attempt).rejects.toThrow(/lanes\.sh\/desktop/);
  });
});

describe('the happy path', () => {
  test('opens the link and says where it landed', async () => {
    const seen: string[] = [];
    const lines = await captured(() =>
      desktop(
        {},
        {
          env: {},
          platform: 'darwin',
          open: async (url) => {
            seen.push(url);
            return true;
          },
        },
      ),
    );

    expect(seen).toEqual(['lanes://settings?page=integrations-link']);
    const out = lines.join('');
    // The menu path, because that is what someone reads back to themselves
    // when the window comes forward on the wrong page.
    expect(out).toContain('Settings → Integrations → Lanes Link');
    // The one failure this command cannot detect: an older app is registered
    // for `lanes://`, exits 0, and ignores an action it does not know.
    expect(out).toContain('older app ignores the link');
  });
});
