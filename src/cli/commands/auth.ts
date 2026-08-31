import { clearSession, isFresh, readSession } from '#auth/lanes/session.ts';
import { DEFAULT_API_URL, currentIdToken, login } from '#auth/lanes/login.ts';
import { print, ok, style, warn } from '../output.ts';

/**
 * `lanes auth` — who this machine is signed in as.
 *
 * A separate area from `lanes link auth`, which is a per-connection credential
 * diagnostic and answers a different question entirely. Neither is renamed and
 * neither gains an alias: one spelling per command, and the help text on each
 * says which is which.
 *
 * Sign-in is required to consume a profile, local endpoints included (ADR-060).
 * That is a real dependency on lanes.sh for a self-hostable tool, and the shape
 * of it is worth stating plainly: **the network is needed to sign in and to
 * refresh, not per request.** A machine offline for a day keeps serving, and
 * `status` below is the command that says how long that has left to run — a
 * session that lapses silently would present as an endpoint that worked
 * yesterday and does not today, which is the worst failure to debug from the
 * outside.
 */

export interface AuthFlags {
  readonly json?: boolean | undefined;
  readonly apiUrl?: string | undefined;
}

export async function authLogin(flags: AuthFlags = {}): Promise<void> {
  const opened: string[] = [];

  const session = await login({
    apiUrl: flags.apiUrl,
    onUrl: (url) => opened.push(url),
    open: async (url) => {
      // Printed as well as opened. A machine with no browser — a container, an
      // SSH session — gets a URL it can paste somewhere that has one, which is
      // the whole difference between "this does not work here" and "this takes
      // one more step here".
      print(style.dim('  Opening your browser to sign in. If nothing opens, use this:'));
      print(`  ${url}`);
      print('');
      await openInBrowser(url);
    },
  });

  if (flags.json === true) {
    print(JSON.stringify({ subject: session.subject, email: session.email }, null, 2));
    return;
  }

  print(ok(`signed in as ${style.bold(session.email ?? session.subject)}`));
  print(style.dim(`      subject  ${session.subject}`));
  print('');
  print(
    style.dim(
      '      A profile reaches you only where its members list that subject:\n' +
        '        lanes link profile members add <subject> --profile <name>',
    ),
  );
  void opened;
}

export async function authLogout(flags: AuthFlags = {}): Promise<void> {
  const session = await readSession();
  await clearSession();

  if (flags.json === true) {
    print(JSON.stringify({ signedOut: session !== null }, null, 2));
    return;
  }

  print(
    session === null
      ? style.dim('Not signed in; nothing to do.')
      : ok(`signed out ${style.bold(session.email ?? session.subject)}`),
  );

  // Said out loud, because it is the surprising half. Signing out removes the
  // identity this machine presents; it does not touch a profile's members list,
  // and it does not revoke a token an agent already holds.
  print(
    style.dim(
      '      Profiles still list you, and a client holding a token still holds it.\n' +
        '      To take a token back: lanes link token rotate --workspace <name>',
    ),
  );
}

export async function authStatus(flags: AuthFlags = {}): Promise<void> {
  const session = await readSession();

  if (session === null) {
    if (flags.json === true) {
      print(JSON.stringify({ signedIn: false }, null, 2));
      return;
    }
    print(warn('not signed in'));
    print(style.dim('      Run: lanes auth login'));
    process.exitCode = 1;
    return;
  }

  const fresh = isFresh(session);

  if (flags.json === true) {
    print(
      JSON.stringify(
        {
          signedIn: true,
          subject: session.subject,
          email: session.email,
          expiresAt: session.expiresAt,
          fresh,
          apiUrl: session.apiUrl,
        },
        null,
        2,
      ),
    );
    return;
  }

  print(ok(`signed in as ${style.bold(session.email ?? session.subject)}`));
  print(`      subject  ${style.dim(session.subject)}`);
  print(`      api      ${style.dim(session.apiUrl)}`);
  print(
    `      token    ${
      fresh
        ? style.dim(`valid until ${session.expiresAt}`)
        : style.dim('expired — the next command refreshes it')
    }`,
  );

  if (session.apiUrl !== DEFAULT_API_URL) {
    print(style.dim(`      This session was issued by ${session.apiUrl}, not the default.`));
  }
}

/**
 * Every workspace this identity can reach, and what it may do there.
 *
 * `GET /v1/me` is the source, and it is the server that decides — the client
 * sends no uid, and the answer is derived from the token. That is what makes
 * this listing something an operator can trust rather than a local guess.
 */
export async function authWorkspaces(flags: AuthFlags = {}): Promise<void> {
  const session = await readSession();
  if (session === null) {
    print(warn('not signed in'));
    print(style.dim('      Run: lanes auth login'));
    process.exitCode = 1;
    return;
  }

  const token = await currentIdToken();
  if (token === null) {
    print(warn('the session could not be refreshed'));
    print(style.dim('      Run: lanes auth login'));
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${session.apiUrl}/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    print(warn(`${session.apiUrl} answered ${response.status}`));
    process.exitCode = 1;
    return;
  }

  const body = (await response.json()) as {
    memberships?: { workspace_id: string; workspace_name: string; role: string }[];
  };
  const memberships = body.memberships ?? [];

  if (flags.json === true) {
    print(JSON.stringify({ memberships }, null, 2));
    return;
  }

  print(style.dim(`signed in as ${session.email ?? session.subject}`));
  print('');

  if (memberships.length === 0) {
    print(style.dim('You are a member of no Lanes workspace yet.'));
  } else {
    for (const one of memberships) {
      print(`  ${style.bold(one.workspace_name)}  ${style.dim(one.role)}`);
      print(`  ${style.dim(one.workspace_id)}`);
    }
  }

  print('');
  print(
    style.dim(
      'A remote lanes link workspace binds to one of these with `lanes_workspace:`\n' +
        'in lanes-link.yaml, which is whose members a profile may delegate to.',
    ),
  );
}

/** Opens a URL, and says nothing if it cannot. The URL is printed either way. */
async function openInBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];

  try {
    await Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' }).exited;
  } catch {
    // Nothing to report: the URL is on screen above, which is the fallback.
  }
}
