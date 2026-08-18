import { describe, expect, test } from 'bun:test';
import { completionPage } from './callback-page.ts';

/**
 * The page nobody sees until the one moment it is the whole product.
 *
 * It is the last screen of a connect flow and the only HTML this repository
 * serves to a human, which makes it exactly the kind of surface that rots
 * unnoticed — it had been dark-only for a year and no test would have said so.
 * Hence the assertions on the light/dark contract rather than on the wording.
 */

const html = (page: Response) => page.text();

describe('the page a browser is handed', () => {
  test('is HTML, with the status the outcome deserves', async () => {
    const good = completionPage({ heading: 'Connected', detail: 'Close this tab.', ok: true });
    expect(good.status).toBe(200);
    expect(good.headers.get('content-type')).toContain('text/html');

    const bad = completionPage({ heading: 'Authorization failed', detail: 'No code.', ok: false });
    expect(bad.status).toBe(400);
  });

  test('says what happened, and what to do next', async () => {
    const body = await html(
      completionPage({
        label: 'Connected',
        heading: 'Google Drive',
        detail: 'You can close this tab and return to the terminal.',
        ok: true,
      }),
    );

    expect(body).toContain('Connected');
    expect(body).toContain('Google Drive');
    expect(body).toContain('You can close this tab and return to the terminal.');
  });

  test('titles the tab with the outcome, not the provider', async () => {
    // The tab strip is a row of eight-character truncations; "Connected" is the
    // word that has to survive it, not the name of what was connected.
    const body = await html(
      completionPage({ label: 'Connected', heading: 'Google Drive', detail: '.', ok: true }),
    );

    expect(body).toContain('<title>Connected</title>');
  });

  test('falls back to the heading for the tab when there is no label', async () => {
    const body = await html(
      completionPage({ heading: 'Authorization failed', detail: '.', ok: false }),
    );

    expect(body).toContain('<title>Authorization failed</title>');
  });

  test('omits the label line entirely rather than rendering an empty one', async () => {
    const body = await html(completionPage({ heading: 'Connected', detail: '.', ok: true }));

    expect(body).not.toContain('class="label"');
  });
});

describe('light and dark', () => {
  test('the page takes the browser colours in both schemes', async () => {
    // Not a palette assertion: `color-scheme` is what makes the transparent
    // background render dark on a dark machine, and losing it is how this page
    // silently became light-only.
    const body = await html(completionPage({ heading: 'Connected', detail: '.', ok: true }));

    expect(body).toContain('color-scheme: light dark');
    expect(body).toContain('background: transparent');
  });

  test('the failure colour is legible against either canvas', async () => {
    const body = await html(completionPage({ heading: 'Failed', detail: '.', ok: false }));

    expect(body).toContain('#A06060'); // on light
    expect(body).toContain('prefers-color-scheme: dark');
    expect(body).toContain('#C08080'); // on dark
  });

  test('the success mark is legible against either canvas', async () => {
    // "Earn your color" — the heading used to be green, which said nothing the
    // word "Connected" did not, and it is still not green. The check is a
    // status glyph rather than emphasis, and it needs the same two-value
    // treatment the failure colour gets: the darker emerald disappears on a
    // dark canvas.
    const body = await html(completionPage({ heading: 'Connected', detail: '.', ok: true }));

    expect(body).toContain('class="icon"');
    expect(body).toContain('#059669'); // on light
    expect(body).toContain('#34D399'); // on dark
    expect(body).not.toContain('class="card err"');
  });

  test('a failure is never marked as a success', async () => {
    // The check and the red heading are the only two things that distinguish
    // the outcomes at a glance, so a failure carrying both would be worse than
    // a failure carrying neither.
    const body = await html(
      completionPage({ heading: 'Authorization failed', detail: '.', ok: false }),
    );

    expect(body).toContain('class="card err"');
    expect(body).not.toContain('class="icon"');
  });
});

describe('untrusted text', () => {
  test('a provider name cannot inject markup', async () => {
    // `heading` now carries `manifest.name`, and a custom provider supplies that
    // from its own YAML file. It is interpolated into HTML we serve on loopback.
    const body = await html(
      completionPage({
        label: 'Connected',
        heading: '<script>alert(1)</script>',
        detail: 'Tom & Jerry "quoted"',
        ok: true,
      }),
    );

    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).toContain('Tom &amp; Jerry &quot;quoted&quot;');
  });
});
