import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The Lanes identity this machine is signed in as.
 *
 * Its own store, beside the desktop app's `~/.lanes/auth.json` rather than
 * inside it: that file holds a uid, an email and a photo URL and no credential,
 * and merging a refresh token into it would change what an existing file means.
 * Two files, one of which is `0600`, is the honest arrangement.
 *
 * **Not in the workspace.** A workspace is a set of accounts and profiles and
 * may be a bucket; who is at the keyboard is neither. Putting this in
 * `~/.lanes-link` would also mean a second workspace signs you out of the
 * first, and would upload the session to a bucket on the next deploy.
 */

/** Where the session lives. Overridable for tests, and for nothing else. */
export function sessionPath(home = homedir()): string {
  return join(home, '.lanes', 'credentials.json');
}

export interface LanesSession {
  /** The Firebase subject, which is what a profile's `members:` names. */
  readonly subject: string;
  readonly email: string | null;
  /** Exchanged for a fresh id token; the long-lived half. */
  readonly refreshToken: string;
  /** The current id token, and when it stops being accepted. */
  readonly idToken: string;
  readonly expiresAt: string;
  /** Which API issued it, so a session cannot be replayed against another. */
  readonly apiUrl: string;
}

export async function readSession(home?: string): Promise<LanesSession | null> {
  try {
    const text = await readFile(sessionPath(home), 'utf8');
    const parsed = JSON.parse(text) as Partial<LanesSession>;

    // Shape-checked rather than trusted. This file is written by us and read on
    // every command, so a half-written or hand-edited one should read as "not
    // signed in" and send somebody to `lanes auth login` — not throw a JSON
    // error out of a command that was about to list their memory.
    if (
      typeof parsed.subject !== 'string' ||
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.idToken !== 'string' ||
      typeof parsed.expiresAt !== 'string' ||
      typeof parsed.apiUrl !== 'string'
    ) {
      return null;
    }

    return {
      subject: parsed.subject,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      refreshToken: parsed.refreshToken,
      idToken: parsed.idToken,
      expiresAt: parsed.expiresAt,
      apiUrl: parsed.apiUrl,
    };
  } catch {
    return null;
  }
}

export async function writeSession(session: LanesSession, home?: string): Promise<void> {
  const path = sessionPath(home);
  await mkdir(dirname(path), { recursive: true });

  // `0600` before the content, and again after: the file holds a refresh token,
  // and a token written world-readable for the instant between two syscalls is
  // still a token that was world-readable.
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function clearSession(home?: string): Promise<void> {
  // Overwritten rather than deleted. An absent file and an empty one both read
  // as signed out, and writing is the operation that cannot half-succeed on a
  // store somebody else is reading.
  await writeFile(sessionPath(home), '{}\n', { mode: 0o600 }).catch(() => {});
}

/**
 * Whether the id token is still worth presenting.
 *
 * A minute of slack, because the thing being avoided is a request that leaves
 * here valid and arrives expired. Refreshing slightly early costs one round
 * trip; refreshing slightly late costs a failed command.
 */
export function isFresh(session: LanesSession, now = Date.now()): boolean {
  const expires = Date.parse(session.expiresAt);
  return Number.isFinite(expires) && expires - now > 60_000;
}
