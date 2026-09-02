import { CONNECTIONS_FILE, nextTokenId, readConnections, tokenRef } from '#profile';
import { readSession } from '#auth/lanes/session.ts';
import { ConfigError } from '#profile';
import { ConfigDocument } from '../../config-edit.ts';
import { openOrCreateConnections } from '../../config-repair-sweep.ts';
import { heading, ok, print, style, warn } from '../../output.ts';
import { openWorkspaceRuntime, type GlobalFlags } from '../../runtime.ts';

/**
 * `lanes link token` — the static tokens this workspace has issued.
 *
 * **A token names a person, and the workspace holds it** (ADR-068). Both halves
 * changed at contract 5. It used to be one credential at `auth.token_ref`,
 * whose default was the constant `profile/token` for every profile in a store
 * that is one per workspace — so `--profile` was asked for and could not affect
 * the answer, and removing a profile deleted the token its siblings were served
 * by. And it resolved to the primary profile's owner with "every profile" as
 * its reach, which made it the one credential on this endpoint that never said
 * who was holding it.
 *
 * So `issue` takes a subject and `show`/`rotate`/`revoke` take a row id. What
 * the token then reaches is whatever that subject is a member of, resolved on
 * every call — the same rule an OAuth token has followed since ADR-060.
 *
 * These are for a machine with no browser. A person registers a client against
 * the bare URL and signs in (ADR-062); `--headless` is the flag that says
 * otherwise, and it is why this family still exists.
 */

export interface TokenFlags extends GlobalFlags {
  readonly show?: boolean | undefined;
  readonly raw?: boolean | undefined;
  readonly id?: string | undefined;
  readonly subject?: string | undefined;
  readonly me?: boolean | undefined;
  readonly label?: string | undefined;
  readonly json?: boolean | undefined;
}

/** The token, or enough of it to recognise. One shape, so every command agrees. */
function show(token: string, reveal: boolean | undefined): string {
  return reveal ? token : `${token.slice(0, 8)}…  ${style.dim('(--show to reveal)')}`;
}

/**
 * Which subject a row is being issued to.
 *
 * `--me` reads the signed-in session rather than asking, because typing your own
 * subject out of `lanes auth status` is a transcription step with a silent
 * failure mode: a mistyped subject is a valid-looking row that matches no
 * member, and the token it holds then reaches nothing for a reason nothing
 * prints. Neither flag is a guess — one of the two is required.
 */
async function subjectFor(flags: TokenFlags): Promise<string> {
  if (flags.subject !== undefined && flags.me === true) {
    throw new ConfigError(
      '--subject and --me both name who the token is for, so pass one.\n' +
        '  --me reads the subject you are signed in as.',
    );
  }

  if (flags.subject !== undefined) return flags.subject;

  if (flags.me !== true) {
    throw new ConfigError(
      'A token is issued to somebody, so say who.\n' +
        '  --me                 the subject you are signed in as\n' +
        '  --subject lanes:<id> somebody else, as "lanes members list" reports them\n' +
        '  What it reaches is whatever that subject is a member of, and nothing else.',
    );
  }

  const session = await readSession().catch(() => null);
  if (!session?.subject) {
    throw new ConfigError(
      '--me needs a signed-in session, and there is none.\n' +
        '  Run: lanes auth login',
    );
  }
  return session.subject;
}

/**
 * Refuse a `--profile` that can no longer mean anything.
 *
 * The alternative is accepting and ignoring it, which `selection.ts` names as
 * the defect it exists to prevent: an operator who passes `--profile work` here
 * believes they scoped the token to one profile, and it is the member list that
 * decides. Saying so is the whole fix.
 */
function assertNoProfile(flags: TokenFlags, command: string): void {
  if (flags.profile === undefined) return;
  throw new ConfigError(
    `--profile does not scope "lanes link token ${command}" (ADR-068).\n` +
      '  A token names the person it was issued to, and reaches every profile whose\n' +
      '  members list them. To narrow what one reaches, edit the member lists:\n' +
      '    lanes link profile members remove --subject <id> --profile <name> --workspace <name>',
  );
}

export async function tokenIssue(flags: TokenFlags): Promise<void> {
  assertNoProfile(flags, 'issue');
  const subject = await subjectFor(flags);

  const runtime = await openWorkspaceRuntime(flags);
  try {
    const root = runtime.resolution.workspaceRoot;
    const existing = (await readConnections(root)).tokens;
    const id = nextTokenId(existing.map((row) => row.id));
    const ref = tokenRef(id);

    const { generateProfileToken } = await import('#auth');
    const token = generateProfileToken();

    // The credential first, then the row. The other order leaves a row naming a
    // ref with nothing behind it, which reads to the authenticator as a token
    // that matches nothing — a working-looking registry whose token is refused.
    await runtime.credentials.set(ref, token);

    // Created from the template if absent, which is what a workspace whose
    // profiles predate `connections.yaml` looks like — and `token issue` is a
    // plausible first write into a fresh one.
    const document = await openOrCreateConnections(root);
    document.addTo(['tokens'], {
      id,
      subject,
      ref,
      ...(flags.label === undefined ? {} : { label: flags.label }),
      issued_at: new Date().toISOString(),
    });
    await document.save();

    print(ok(`issued ${style.bold(id)} to ${subject}`));
    print(`  ${show(token, flags.show)}`);
    print();

    const reaches = await profilesFor(root, subject);
    if (reaches.length === 0) {
      print(warn('no profile in this workspace lists that subject, so this token reaches nothing'));
      print(
        style.dim(
          '  Add them: lanes link profile members add --subject ' +
            `${subject} --profile <name> --workspace ${runtime.target}`,
        ),
      );
    } else {
      print(style.dim(`  Reaches: ${reaches.join(', ')} — every profile listing that subject.`));
    }
  } finally {
    await runtime.close();
  }
}

export async function tokenList(flags: TokenFlags): Promise<void> {
  const runtime = await openWorkspaceRuntime(flags);
  try {
    const root = runtime.resolution.workspaceRoot;
    const rows = (await readConnections(root)).tokens;

    if (flags.json) {
      const payload = await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          subject: row.subject,
          ...(row.label === undefined ? {} : { label: row.label }),
          ...(row.issued_at === undefined ? {} : { issued_at: row.issued_at }),
          reaches: await profilesFor(root, row.subject),
          present: (await runtime.credentials.get(row.ref)) !== null,
        })),
      );
      print(JSON.stringify({ target: runtime.target, tokens: payload }, null, 2));
      return;
    }

    if (rows.length === 0) {
      print('No token has been issued in this workspace.');
      print(
        style.dim(
          '  A person does not need one: a client registers against the bare URL and signs in.\n' +
            `  For a machine with no browser: lanes link token issue --me --workspace ${runtime.target}`,
        ),
      );
      return;
    }

    heading(`Tokens (${rows.length})`);
    for (const row of rows) {
      const reaches = await profilesFor(root, row.subject);
      // A row whose credential is gone matches nothing, and reads exactly like a
      // wrong token from the client's side. Naming it here is the cheap half of
      // what `doctor` says at length.
      const missing = (await runtime.credentials.get(row.ref)) === null;
      print(
        `  ${row.id}  ${row.subject}` +
          (row.label ? `  ${style.dim(`(${row.label})`)}` : '') +
          `  ${reaches.length > 0 ? reaches.join(', ') : style.dim('reaches nothing')}` +
          (missing ? `  ${style.dim('— value missing from the store')}` : ''),
      );
    }
    print(style.dim('  What each reaches is every profile whose members list its subject.'));
  } finally {
    await runtime.close();
  }
}

export async function tokenShow(flags: TokenFlags): Promise<void> {
  assertNoProfile(flags, 'show');
  const runtime = await openWorkspaceRuntime(flags);
  try {
    const root = runtime.resolution.workspaceRoot;
    const row = pick((await readConnections(root)).tokens, flags, runtime.target);
    const token = await runtime.credentials.get(row.ref);

    if (token === null) {
      throw new ConfigError(
        `Token "${row.id}" has a row but no value at "${row.ref}" in this workspace's store.\n` +
          `  Re-mint it: lanes link token rotate --id ${row.id} --workspace ${runtime.target}`,
      );
    }

    // `--raw` prints the token and nothing else, for command substitution:
    //
    //   export LANES_LINK_TOKEN="$(lanes link token show --raw --workspace local)"
    //
    // A token pasted from `--show` passes through the agent's context and into
    // its transcript; substituted by the shell it goes from this process to the
    // consumer and is never seen by the model at all.
    if (flags.raw) {
      process.stdout.write(`${token}\n`);
      return;
    }

    print(`${row.id}  ${row.subject}`);
    print(show(token, flags.show));
  } finally {
    await runtime.close();
  }
}

export async function tokenRotate(flags: TokenFlags): Promise<void> {
  assertNoProfile(flags, 'rotate');
  const runtime = await openWorkspaceRuntime(flags);
  try {
    const root = runtime.resolution.workspaceRoot;
    const row = pick((await readConnections(root)).tokens, flags, runtime.target);

    const { generateProfileToken } = await import('#auth');
    const token = generateProfileToken();
    await runtime.credentials.set(row.ref, token);

    print(ok(`rotated ${style.bold(row.id)}`));
    // Gated the way `tokenShow` gates it, and for the same reason: a token
    // printed here goes into the transcript of whatever ran the command.
    // Rotating is what an operator does *because* a token leaked, so printing
    // the replacement unasked is the one moment it costs the most.
    print(`  ${show(token, flags.show)}`);
    print();
    // Narrower than it used to be, and worth saying so. A rotate used to
    // invalidate every agent on the endpoint, because there was one token and
    // every registration carried it. Registrations do not carry one now
    // (ADR-062), so this affects only what was given *this* row's value.
    print(warn(`anything holding ${row.id} must be given the new value`));
    print(style.dim('  Clients that signed in through a browser are unaffected — they hold their own tokens.'));
  } finally {
    await runtime.close();
  }
}

export async function tokenRevoke(flags: TokenFlags): Promise<void> {
  assertNoProfile(flags, 'revoke');
  const runtime = await openWorkspaceRuntime(flags);
  try {
    const root = runtime.resolution.workspaceRoot;
    const rows = (await readConnections(root)).tokens;
    const row = pick(rows, flags, runtime.target);

    // The row first, then the credential. This is the reverse of `issue` and
    // for the same reason read the other way: what must never survive a partial
    // failure is a *usable* token, so the thing that makes it usable goes last.
    const document = await ConfigDocument.openKey(root, CONNECTIONS_FILE);
    document.removeFrom(['tokens'], rows.indexOf(row));
    await document.save();

    await runtime.credentials.delete(row.ref);

    print(ok(`revoked ${style.bold(row.id)}`));
    print(style.dim('  It is refused within the authenticator\'s cache window, which is seconds.'));
  } finally {
    await runtime.close();
  }
}

/**
 * The row a command acts on.
 *
 * With one row and no `--id`, that row: naming it would be ceremony, and the
 * common workspace has exactly one. With several, it refuses and lists them —
 * the `deploy` rule, for the same reason. Nothing is chosen from among
 * candidates.
 */
function pick(
  rows: readonly { id: string; subject: string; ref: string }[],
  flags: TokenFlags,
  target: string,
): { id: string; subject: string; ref: string } {
  if (rows.length === 0) {
    throw new ConfigError(
      'No token has been issued in this workspace.\n' +
        `  Issue one: lanes link token issue --me --workspace ${target}`,
    );
  }

  if (flags.id !== undefined) {
    const found = rows.find((row) => row.id === flags.id);
    if (!found) {
      throw new ConfigError(
        `No token "${flags.id}" in this workspace. Have: ${rows.map((row) => row.id).join(', ')}.`,
      );
    }
    return found;
  }

  if (rows.length > 1) {
    throw new ConfigError(
      `This workspace has ${rows.length} tokens, so this command needs --id.\n` +
        rows.map((row) => `    ${row.id}  ${row.subject}`).join('\n'),
    );
  }

  return rows[0]!;
}

/** Every profile in this workspace whose `members:` names a subject. */
async function profilesFor(root: string, subject: string): Promise<string[]> {
  const { loadWorkspaceProfiles } = await import('#profile');
  const { loaded } = await loadWorkspaceProfiles(root);
  return loaded
    .filter((entry) => entry.config.members.some((member) => member.subject === subject))
    .map((entry) => entry.profile);
}
