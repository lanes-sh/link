import { describe, expect, test } from 'bun:test';
import { completionPage, noticePage } from './callback-page.ts';

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
  test('both schemes are defined, and the page paints them', async () => {
    // This used to assert `background: transparent` — the page left its canvas
    // to the browser, which is how it survived a year of being dark-only. The
    // design system names a background per mode instead, so the contract is now
    // that both are declared and the body actually uses one. `color-scheme`
    // stays either way: form controls and scrollbars still read it.
    const body = await html(completionPage({ heading: 'Connected', detail: '.', ok: true }));

    expect(body).toContain('color-scheme: light dark');
    expect(body).toContain('--background: #EBEAE7');
    expect(body).toContain('prefers-color-scheme: dark');
    expect(body).toContain('--background: #171717');
    expect(body).toContain('background: var(--background)');
  });

  test('the failure colour is the destructive token, which is one value', async () => {
    // It was `#A06060` lightened to `#C08080` on a dark canvas. The token is a
    // single value for both, so the second is gone — and a reintroduced pair
    // would be this page drifting from the system again, which is the whole
    // failure this file exists to catch.
    const body = await html(completionPage({ heading: 'Failed', detail: '.', ok: false }));

    expect(body).toContain('--destructive: #A06060');
    expect(body).toContain('color: var(--destructive)');
    expect(body).not.toContain('#C08080');
  });

  test('the success mark is gold, because gold is the only accent', async () => {
    // The check used to be emerald, matching the tick the Lanes app puts against
    // a connected integration. The design system is explicit — "gold for
    // positive, neutral tokens otherwise" — so the green was the odd one out
    // rather than the match it was meant to be.
    const body = await html(completionPage({ heading: 'Connected', detail: '.', ok: true }));

    expect(body).toContain('class="icon"');
    expect(body).toContain('--accent-gold: #A1845A');
    expect(body).toContain('.icon { display: block; margin: 0 auto 18px; color: var(--accent-gold); }');
    expect(body).not.toContain('#059669');
    expect(body).not.toContain('#34D399');
  });

  test('a failure is never marked as a success', async () => {
    // The check and the destructive heading are the only two things that
    // distinguish the outcomes at a glance, so a failure carrying both would be
    // worse than a failure carrying neither.
    const body = await html(
      completionPage({ heading: 'Authorization failed', detail: '.', ok: false }),
    );

    expect(body).toContain('err');
    expect(body).not.toContain('class="icon"');
  });

  test('a success carries no error styling', async () => {
    const body = await html(completionPage({ heading: 'Connected', detail: '.', ok: true }));

    expect(body).toContain('class="card surface"');
    expect(body).not.toContain('card surface err');
  });
});

describe('a refusal, read by the person it happened to', () => {
  test('says what to do next, which is the whole reason it is a page', async () => {
    // The message that matters: somebody signed in successfully and no profile
    // on this endpoint lists them. Returned as bare text it read as a protocol
    // error to a client; the audience is a person at a browser who needs to
    // know what to ask their operator for.
    const body = await html(
      noticePage(
        'You are signed in as her@example.com, and no profile on this endpoint lists ' +
          'you as a member.\n\nIts owner can add you with:\n  lanes link profile members add lanes:ABC --profile <name>',
        403,
      ),
    );

    expect(body).toContain('Not authorised');
    expect(body).toContain('no profile on this endpoint lists you');
    expect(body).toContain('lanes link profile members add lanes:ABC');
  });

  test('keeps the status, so a client following the redirect still sees a failure', () => {
    expect(noticePage('nope', 403).status).toBe(403);
    expect(noticePage('nope', 400).status).toBe(400);
  });

  test('is the error card, not the success one', async () => {
    const body = await html(noticePage('nope', 400));

    expect(body).toContain('card surface err');
  });

  test('carries no script, so the policy stays narrow', () => {
    // The page this replaces asked for the endpoint token and ran an inline
    // listener to disable its button. Nothing here submits anything, so the
    // widening that paid for goes away with it (ADR-062).
    const csp = noticePage('nope', 400).headers.get('content-security-policy') ?? '';

    expect(csp).not.toContain('script-src');
    expect(csp).toContain("form-action 'self';");
  });

  test('cannot be made to carry markup', async () => {
    // The subject in that message comes from an assertion, and the email from
    // whatever the person signed in with.
    const body = await html(noticePage('<script>alert(1)</script>', 403));

    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
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

