import { OAuthStore, type LiveSession } from '#auth';
import { readSession } from '#auth/lanes/session.ts';
import { ConfigError } from '#profile';
import { heading, ok, print, printable, style } from '../../output.ts';
import { confirm, isInteractive } from '../../prompt.ts';
import { openWorkspaceRuntime, type GlobalFlags } from '../../runtime.ts';

/**
 * `lanes link session` — the browser sign-ins this endpoint is holding.
 *
 * **A separate noun from `token`, and the split is the same one `grant` and
 * `disconnect` keep.** A token is a declared row in `connections.yaml` with an
 * id, a label and a subject; a session is a live record in the workspace's
 * state under `oauth.v1`, with nothing declaring it anywhere. `token revoke`
 * already means "delete a declared row", and overloading it to also mean "end
 * somebody's browser sign-in" would give one spelling two meanings — which is
 * how an operator comes to run the wrong one and be told it worked.
 *
 * ## Why this exists at all, and what it is not
 *
 * Membership is resolved on every request now (ADR-083), so
 * `profile members remove` ends a session within seconds and is the right tool
 * for "they should not have this any more". This is for the other case: the
 * credential itself is suspect — pasted somewhere, logged, on a lost machine —
 * and the member row is still correct. Nothing in the CLI could reach
 * `OAuthStore`, so that case had no answer but waiting out
 * `access_token_ttl_minutes`.
 *
 * The two are complementary and the report says so, because a revoke without
 * the member edit is undone by the next sign-in: this is imperative, and
 * `members remove` is declarative.
 *
 * ## Workspace level
 *
 * `oauth.v1` is a workspace namespace, so one store serves every profile and a
 * session belongs to the endpoint rather than to any one of them. `--profile`
 * would be a flag that could not affect the answer, which is the mistake
 * ADR-068 removed from the `token` family.
 */

export interface SessionFlags extends GlobalFlags {
  readonly subject?: string | undefined;
  readonly me?: boolean | undefined;
  readonly yes?: boolean | undefined;
  readonly json?: boolean | undefined;
}

/**
 * Whose sessions, out of `--subject` or `--me`.
 *
 * The same rule `token issue` applies, said in this command's own words rather
 * than shared with it: the conflict check is three lines and the refusals are
 * the valuable part, and "a token is issued to somebody" is not what is being
 * asked here. Extract it if a third command needs it.
 */
async function subjectFor(flags: SessionFlags): Promise<string> {
  if (flags.subject !== undefined && flags.me === true) {
    throw new ConfigError(
      '--subject and --me both name whose sessions to end, so pass one.\n' +
        '  --me reads the subject you are signed in as.',
    );
  }

  if (flags.subject !== undefined) return flags.subject;

  if (flags.me !== true) {
    throw new ConfigError(
      'Whose sessions? This ends a sign-in, so say who.\n' +
        '  --me                 the subject you are signed in as\n' +
        '  --subject lanes:<id> somebody else, as "lanes link session list" reports them\n' +
        '  To stop the next sign-in as well: lanes link profile members remove <subject>',
    );
  }

  const session = await readSession().catch(() => null);
  if (!session?.subject) {
    throw new ConfigError('--me needs a signed-in session, and there is none.\n  Run: lanes auth login');
  }
  return session.subject;
}

/** How long a session has left, in the roughest useful unit. */
function remaining(expiresAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((expiresAt - now) / 60_000));
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.round(minutes / 60)}h left`;
}

async function describe(
  store: OAuthStore,
  sessions: readonly LiveSession[],
): Promise<{ subject: string; client: string; family: string; expiresAt: number }[]> {
  return Promise.all(
    sessions.map(async (one) => ({
      // Both through `printable`, because both reach a terminal and one of them
      // is whatever an unauthenticated `POST /register` sent. The name is shown
      // at all because a `client_id` is opaque and an operator deciding whether
      // to end a session needs to recognise what they are ending.
      subject: printable(one.subject),
      client: printable((await store.client(one.clientId))?.clientName ?? one.clientId),
      family: one.family,
      expiresAt: one.expiresAt,
    })),
  );
}

export async function sessionList(flags: SessionFlags): Promise<void> {
  const runtime = await openWorkspaceRuntime(flags);
  try {
    const store = new OAuthStore(runtime.state.kv);
    const rows = await describe(store, await store.sessions());
    const now = Date.now();

    if (flags.json) {
      print(JSON.stringify({ target: runtime.target, sessions: rows }, null, 2));
      return;
    }

    if (rows.length === 0) {
      print('No browser session is open on this endpoint.');
      print(
        style.dim(
          '  A client that signed in and then stopped calling still holds a token until it\n' +
            '  expires; this lists what the endpoint is actually holding.',
        ),
      );
      return;
    }

    heading('sessions');
    for (const row of rows) {
      print(`  ${row.subject}  ${style.dim(row.client)}  ${style.dim(remaining(row.expiresAt, now))}`);
    }
    print(
      style.dim(
        '\n  End one with: lanes link session revoke --subject <subject>\n' +
          '  To stop the next sign-in too: lanes link profile members remove <subject>',
      ),
    );
  } finally {
    await runtime.close();
  }
}

export async function sessionRevoke(flags: SessionFlags): Promise<void> {
  const subject = await subjectFor(flags);
  const runtime = await openWorkspaceRuntime(flags);

  try {
    const store = new OAuthStore(runtime.state.kv);
    const mine = (await store.sessions()).filter((one) => one.subject === subject);

    if (mine.length === 0) {
      print(style.dim(`${subject} holds no session on this endpoint.`));
      return;
    }

    const rows = await describe(store, mine);
    if (!flags.yes && isInteractive()) {
      heading('about to end');
      for (const row of rows) print(`  ${row.subject}  ${style.dim(row.client)}`);
      if (!(await confirm(`End ${rows.length} session${rows.length === 1 ? '' : 's'}?`, true))) {
        print(style.dim('  cancelled'));
        return;
      }
    }

    // One pass per family rather than per token: a family is one authorization
    // and its refresh chain, so dropping the family is what ends the sign-in
    // rather than leaving a refresh token able to mint another access token.
    for (const family of new Set(mine.map((one) => one.family))) {
      await store.revokeFamily(family);
    }

    if (flags.json) {
      print(JSON.stringify({ target: runtime.target, subject, ended: rows }, null, 2));
      return;
    }

    print(ok(`ended ${rows.length} session${rows.length === 1 ? '' : 's'} for ${style.bold(subject)}`));
    for (const row of rows) print(`      ${style.dim(row.client)}`);
    print(
      style.dim(
        '      Other instances stop honouring it within seconds; they each hold the\n' +
          '      record for a short window and re-read it after.\n' +
          '      This does not stop them signing in again — for that:\n' +
          `      lanes link profile members remove ${subject} --profile <name>`,
      ),
    );
  } finally {
    await runtime.close();
  }
}
