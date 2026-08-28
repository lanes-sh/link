import { ok, print, style } from '../../output.ts';

/**
 * `lanes link desktop` — open the Lanes app, on its Lanes Link page.
 *
 * `lanes link dashboard` is the same command under its older name. That name
 * used to mean a page this endpoint served at `/dashboard`, and ADR-053 retired
 * it: the desktop app has a Lanes Link settings page that runs these same
 * commands, so the served page was the second, weaker copy of one surface.
 *
 * What is left is small on purpose. It resolves no profile and opens no
 * runtime, which is what lets it be `'none'` in `selection.ts` — there is
 * nothing here that depends on which profile or target you meant. The app holds
 * its own selection, and a command that demanded two values it then discarded
 * would only be asking for them out of habit.
 */

/**
 * The scheme the released Lanes app registers with LaunchServices.
 *
 * `lanes-dev` and `lanes-stage` are separate builds registering separate
 * schemes, so testing against either means naming it — see
 * `LANES_LINK_APP_SCHEME` below.
 */
const SCHEME = 'lanes';

/**
 * The settings page id.
 *
 * A contract with another repository: it is `SETTINGS_PAGE_IDS` in the app's
 * `src/settings/nav.ts`, and a test there pins this spelling precisely because
 * renaming it would break this command with nothing on either side reporting a
 * failure. The app opens Settings on its current page rather than refusing an
 * id it does not have, so a mismatch degrades instead of dying — which also
 * means it is invisible.
 */
const PAGE = 'integrations-link';

export interface DesktopFlags {
  /** Print the URL instead of opening it. */
  readonly print?: boolean | undefined;
}

/** Injected in tests. Every field is the real thing when absent. */
export interface DesktopDeps {
  readonly env?: Record<string, string | undefined> | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  /** Hand the URL to the OS. Resolves false when nothing claimed the scheme. */
  readonly open?: ((url: string) => Promise<boolean>) | undefined;
}

/** The deep link, and the one env var that points it at another build. */
export function settingsUrl(env: Record<string, string | undefined> = process.env): string {
  // `||`, not `??`: an empty `LANES_LINK_APP_SCHEME` is someone unsetting it in
  // a shell, and `://settings` is not a URL anything can open.
  return `${env['LANES_LINK_APP_SCHEME'] || SCHEME}://settings?page=${PAGE}`;
}

/**
 * Awaited, unlike `defaultOpenBrowser` in `oauth.ts`, and not the same function.
 *
 * That one is fire-and-forget because an OAuth consent has to outlive the
 * command and `xdg-open` can block for as long as the browser it exec'd. This
 * one runs on darwin only, where `open` hands off to LaunchServices and returns
 * immediately — so the exit code is free, and it is the only thing that
 * separates "the app is installed" from "nothing on this machine answers
 * `lanes://`". Merging the two would mean giving one of them the wrong
 * behaviour.
 */
async function openUrl(url: string): Promise<boolean> {
  try {
    // An argument array, never a shell string: the URL carries a query.
    const child = Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

export async function desktop(flags: DesktopFlags, deps: DesktopDeps = {}): Promise<void> {
  const url = settingsUrl(deps.env ?? process.env);

  if (flags.print) {
    // Alone on stdout, so `open "$(lanes link desktop --print)"` works. Unlike
    // the URL this printed when it opened a served page, it carries no token
    // and is the same string every time — which is why it needs no flag to
    // justify it beyond the terminal that has no browser.
    print(url);
    return;
  }

  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') {
    // The app is macOS-only; this CLI is not. Saying so beats spawning
    // `xdg-open` at a scheme no Linux machine has ever registered.
    throw new Error(
      `The Lanes desktop app is macOS-only, and this is ${platform}.\n` +
        `  What it would have opened: ${url}\n` +
        '  Everything that page does is a command here — start with: lanes link status',
    );
  }

  const opened = await (deps.open ?? openUrl)(url);
  if (!opened) {
    throw new Error(
      'Nothing on this machine answers a lanes:// link, so the Lanes app is not installed.\n' +
        '  Get it: https://lanes.sh/desktop\n' +
        '  Or print the link and open it yourself: lanes link desktop --print',
    );
  }

  print(ok(`opened ${style.bold('Lanes')} → Settings → Integrations → Lanes Link`));
  // The one failure this command cannot see. An older Lanes is still registered
  // for `lanes://`, so `open` exits 0, and it then ignores an action it does not
  // know — the app comes forward on whatever page it was already on.
  print(style.dim('  needs Lanes 0.48.0 or newer; an older app ignores the link.'));
}
