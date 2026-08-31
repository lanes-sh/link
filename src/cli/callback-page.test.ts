import { describe, expect, test } from 'bun:test';
import { approvalPage, completionPage } from './callback-page.ts';

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

describe('approving', () => {
  const page = () =>
    approvalPage({
      client: 'Claude',
      redirectHost: 'claude.ai',
      fields: {},
      action: '/authorize',
      retry: false,
      target: 'local',
    });

  test('names the command and nothing around it', async () => {
    // No lead-in and no full stop: the line is there to be selected and run,
    // and a trailing period is a character that gets copied with it.
    const body = await html(page());

    expect(body).toContain('<code>lanes link outputs --show --workspace local</code>');
    expect(body).not.toContain('Printed by');
    expect(body).not.toContain('--workspace local</code>.');
  });

  test('the button becomes busy, and stops accepting clicks', async () => {
    // Approving is a round trip. Until it returns the page looks untouched,
    // which reads as "nothing happened" — and the second click is the one that
    // sends a duplicate. Disabling is the half that matters; the spinner says why.
    const body = await html(page());

    expect(body).toContain("addEventListener('submit'");
    expect(body).toContain("classList.add('busy')");
    expect(body).toContain('button.disabled = true');
    expect(body).toContain('.go.busy::after');
    expect(body).toContain('animation: spin');
  });

  test('the spinner is monochrome, because a request in flight is not a verdict', async () => {
    const body = await html(page());

    expect(body).toContain('border-top-color: var(--foreground)');
    expect(body).not.toContain('border-top-color: var(--accent-gold)');
  });

  test('a page with script says so in its policy, and one without does not', () => {
    // The consent screen is the page that asks for the endpoint token, so the
    // inline listener it now carries is the one place this widening is spent.
    const withScript = approvalPage({
      client: 'C',
      redirectHost: 'example.com',
      fields: {},
      action: '/authorize',
      retry: false,
      target: 'local',
    });
    const without = completionPage({ heading: 'Connected', detail: '.', ok: true });

    expect(withScript.headers.get('content-security-policy')).toContain("script-src 'unsafe-inline'");
    expect(without.headers.get('content-security-policy')).not.toContain('script-src');
  });

  test('the policy admits the destination named on the page, and only that one', () => {
    // `form-action` is checked against the redirect the approval produces, not
    // just the `action` — so the one origin this page tells the reader about is
    // the one origin it has to admit. Anything else and the browser refuses to
    // deliver a code that has already been minted.
    const csp =
      approvalPage({
        client: 'C',
        redirectHost: 'client.example',
        formAction: 'https://client.example',
        fields: {},
        action: '/authorize',
        retry: false,
        target: 'local',
      }).headers.get('content-security-policy') ?? '';

    expect(csp).toContain("form-action 'self' https://client.example;");
    expect(csp).not.toContain('https://other.example');
  });

  test('a page given no destination keeps the narrow policy', () => {
    // A redirect this endpoint could not parse never reaches consent, so the
    // absence is a real state rather than a caller forgetting the field.
    const csp =
      approvalPage({
        client: 'C',
        redirectHost: 'client.example',
        fields: {},
        action: '/authorize',
        retry: false,
        target: 'local',
      }).headers.get('content-security-policy') ?? '';

    expect(csp).toContain("form-action 'self';");
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

describe('the approval page', () => {
  const approval = (target: string) =>
    approvalPage({
      client: 'Claude',
      redirectHost: 'claude.ai',
      action: 'https://endpoint.example/authorize',
      fields: { client_id: 'abc' },
      retry: false,
      target,
    });

  test('names the target whose store holds the token it is asking for', async () => {
    // The reader runs this in a shell that resolves a target of its own, and
    // credentials are per-target. A bare `--show` sends the owner of a deployed
    // endpoint to the local store, which either holds a token this endpoint
    // will refuse or holds none and has one minted on the spot.
    const body = await html(approval('cloud'));

    expect(body).toContain('lanes link outputs --show --workspace cloud');
    expect(body).not.toContain('outputs --show</code>');
  });

  test('names it even when it is the default, so the flag is never ambiguous', async () => {
    const body = await html(approval('local'));

    expect(body).toContain('lanes link outputs --show --workspace local');
  });

  test('a target name cannot inject markup', async () => {
    // It comes from config rather than from a request, but everything else on
    // this page is escaped and a value reaching HTML is not where to make an
    // exception.
    const body = await html(approval('<script>alert(1)</script>'));

    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
