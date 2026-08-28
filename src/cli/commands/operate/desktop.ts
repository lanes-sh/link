import { ok, print, progress, style, warn } from '../../output.ts';
import { confirm, isInteractive } from '../../prompt.ts';

/**
 * `lanes link desktop` — open the Lanes app, on its Lanes Link page.
 *
 * `lanes link dashboard` is the same command under its older name. That name
 * used to mean a page this endpoint served at `/dashboard`, and ADR-053 retired
 * it: the desktop app has a Lanes Link settings page that runs these same
 * commands, so the served page was the second, weaker copy of one surface.
 *
 * It resolves no profile and opens no runtime, which is what lets it be `'none'`
 * in `selection.ts` — nothing here depends on which profile or target you meant.
 * The app holds its own selection, and a command that demanded two values it
 * then discarded would only be asking out of habit.
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

/**
 * How the app is installed, in the tap's own spelling.
 *
 * Homebrew rather than a download, for the same reason the app installs this
 * CLI with `bun install -g` rather than sending someone to npm: an install a
 * command performs has to be one an upgrade later finds. It is only ever
 * reached on darwin, since the platform check turns everything else away first.
 */
const INSTALL = ['brew', 'install', '--cask', 'lanes-sh/lanes/lanes'] as const;

/** Enough of the tail to explain an exit code, and no more. */
const KEPT_STDERR = 4096;

export interface DesktopFlags {
  /** Print the URL instead of opening it. */
  readonly print?: boolean | undefined;
  /** Install without asking first. */
  readonly yes?: boolean | undefined;
}

/** Injected in tests. Every field is the real thing when absent. */
export interface DesktopDeps {
  readonly env?: Record<string, string | undefined> | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  /** Hand the URL to the OS. Resolves false when nothing claimed the scheme. */
  readonly open?: ((url: string) => Promise<boolean>) | undefined;
  /** Where `brew` is, or null. */
  readonly brew?: (() => string | null) | undefined;
  /** Run the install. Resolves an error tail, or null on success. */
  readonly install?: ((brew: string) => Promise<string | null>) | undefined;
  readonly interactive?: boolean | undefined;
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
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
 * `lanes://`". Merging the two would give one of them the wrong behaviour.
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

/**
 * Run the cask install, streaming it.
 *
 * Streamed rather than captured for the reason `runGcloud` is: a download of
 * this size takes long enough that silence is indistinguishable from a hang.
 * stderr is kept as well as shown, because "no such cask" and "the tap is
 * unreachable" both exit 1 and need different answers.
 */
async function runInstall(brew: string): Promise<string | null> {
  const child = Bun.spawn([brew, ...INSTALL.slice(1)], { stdout: 'inherit', stderr: 'pipe' });

  let captured = '';
  const decoder = new TextDecoder();
  const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    process.stderr.write(text);
    captured = (captured + text).slice(-KEPT_STDERR);
  }

  return (await child.exited) === 0 ? null : captured.trim();
}

/**
 * Install the app, having established that nothing answers the scheme.
 *
 * It asks first. Everything else this CLI installs is a file in the workspace
 * it already owns; this puts an application on the machine, which is the
 * largest side effect any command here has and the one a person is most
 * entitled to decline. `--yes` is for the run that already decided, and a
 * pipe with no terminal is refused rather than assumed — the same split
 * `knowledge use` makes (ADR-041).
 */
async function install(flags: DesktopFlags, deps: DesktopDeps): Promise<void> {
  const line = INSTALL.join(' ');
  const brew = (deps.brew ?? (() => Bun.which('brew')))();

  if (!brew) {
    // Nothing to offer: this is the one path where the command cannot finish
    // the job, so it hands over the whole of it.
    throw new Error(
      'The Lanes app is not installed, and neither is Homebrew.\n' +
        `  With Homebrew: ${line}\n` +
        '  Without it, download the app: https://lanes.sh/desktop',
    );
  }

  print(warn('the Lanes app is not installed'));
  print(style.dim(`  ${line}`));

  const interactive = deps.interactive ?? isInteractive();
  if (!flags.yes) {
    if (!interactive) {
      // A script cannot answer, and installing an application because nobody
      // was there to say no is the wrong way to resolve that.
      throw new Error(
        `Nothing here can answer a prompt. Run the line above, or pass --yes to install it.`,
      );
    }
    if (!(await (deps.confirm ?? ((q: string) => confirm(q)))('Install it now?'))) {
      throw new Error(`Not installed. When you want it: ${line}`);
    }
  }

  progress(style.dim('  installing, which takes a minute the first time…'));
  const failed = await (deps.install ?? runInstall)(brew);
  if (failed !== null) {
    throw new Error(`${line} failed.\n${failed || '  It printed nothing that explains why.'}`);
  }
  print(ok('installed Lanes'));
}

export async function desktop(flags: DesktopFlags, deps: DesktopDeps = {}): Promise<void> {
  const url = settingsUrl(deps.env ?? process.env);

  if (flags.print) {
    // Alone on stdout, so `open "$(lanes link desktop --print)"` works. Unlike
    // the URL this printed when it opened a served page, it carries no token
    // and is the same string every time.
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

  const open = deps.open ?? openUrl;
  if (await open(url)) {
    print(ok(`opened ${style.bold('Lanes')} → Settings → Integrations → Lanes Link`));
    // The one failure this command cannot see. An older Lanes is still
    // registered for `lanes://`, so `open` exits 0, and it then ignores an
    // action it does not know — the app comes forward on whatever page it was
    // already on. Not printed after an install below, where the version is
    // whatever the tap just handed over.
    print(style.dim('  needs Lanes 0.48.0 or newer; an older app ignores the link.'));
    return;
  }

  await install(flags, deps);

  if (!(await open(url))) {
    // Installed, and the scheme still unclaimed. LaunchServices registers a
    // cask's bundle as it lands, but not always before the next process asks.
    throw new Error(
      'Lanes is installed, but nothing answers a lanes:// link yet.\n' +
        '  macOS registers the scheme a moment after the app lands. Try again: lanes link desktop',
    );
  }

  print(ok(`opened ${style.bold('Lanes')} → Settings → Integrations → Lanes Link`));
}
