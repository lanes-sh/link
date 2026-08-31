import { readSession } from '#auth/lanes/session.ts';
import { ConfigError, readRegistry, resolveWorkspaceRoot } from '#profile';
import { ConfigDocument } from '../config-edit.ts';
import { announce, emit, ok, print, style, table } from '../output.ts';
import { nextAfterEdit, publishProfileEdit } from '../publish.ts';
import { resolveProfile, type GlobalFlags } from '../runtime.ts';

/**
 * `lanes link profile members` — who may consume a profile (ADR-060).
 *
 * CLI-only, like everything that authorises future agent behaviour (ADR-007),
 * and for the sharpest version of that argument: an agent able to edit this
 * could add itself.
 *
 * **A subject is validated against the Lanes workspace where there is one.** A
 * remote workspace binds to a Lanes workspace with `lanes_workspace:`, and a
 * member of that is somebody the server already vouches for. For `local` there
 * is no such list, so the only subject accepted is the signed-in one — a local
 * workspace delegating to a stranger is a typo, not a use case.
 */

export interface MemberRow {
  readonly subject: string;
  readonly role: 'owner' | 'member';
  /** Whether this is the identity running the command. */
  readonly you: boolean;
}

export async function membersList(flags: GlobalFlags & { json?: boolean }): Promise<void> {
  const { resolution, config } = await resolveProfile(flags);
  const session = await readSession();

  const rows: MemberRow[] = config.members.map((member) => ({
    subject: member.subject,
    role: member.role,
    you: member.subject === session?.subject,
  }));

  return emit(flags.json, { profile: resolution.profile, members: rows }, () => {
    announce(resolution);

    if (rows.length === 0) {
      // Empty is nobody, and saying so matters: the natural reading of a blank
      // list is "no restriction", which is the opposite of what it means.
      print(style.dim('No members. Nobody may consume this profile.'));
      print(style.dim('  Add yourself with: lanes link profile members add --me'));
      return;
    }

    table(
      rows.map((row) => [
        `  ${style.bold(row.subject)}`,
        row.role,
        row.you ? style.dim('you') : '',
      ]),
    );
  });
}

export interface MembersFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
  /** Add the signed-in subject, rather than one typed out. */
  readonly me?: boolean | undefined;
  readonly role?: string | undefined;
}

export async function membersAdd(
  subject: string | undefined,
  flags: MembersFlags,
): Promise<void> {
  const { resolution, config, target } = await resolveProfile(flags);
  const session = await readSession();

  const wanted = flags.me === true ? session?.subject : subject;

  if (wanted === undefined) {
    throw new ConfigError(
      flags.me === true
        ? 'Not signed in, so there is no "me" to add. Run: lanes auth login'
        : 'Which subject? Run: lanes link profile members add <subject> --profile <name>\n' +
          '  Or add yourself: lanes link profile members add --me --profile <name>',
    );
  }

  const role = flags.role === 'owner' ? 'owner' : 'member';

  if (config.members.some((member) => member.subject === wanted)) {
    print(style.dim(`${resolution.profile} already lists ${wanted}.`));
    return;
  }

  await assertDelegatable(wanted, target, session?.subject);

  const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);
  document.addTo(['members'], { subject: wanted, role }, { inline: true });
  await document.save();

  const published = nextAfterEdit(await publishProfileEdit({ resolution, config, target }));

  return emit(flags.json, { profile: resolution.profile, subject: wanted, role }, () => {
    announce(resolution);
    print(ok(`${wanted} may now consume ${style.bold(resolution.profile)} as ${role}`));
    print(style.dim('      They reach exactly what this profile grants, and nothing else.'));
    if (published) print(style.dim(`      ${published}`));
  });
}

export async function membersRemove(
  subject: string | undefined,
  flags: MembersFlags,
): Promise<void> {
  const { resolution, config, target } = await resolveProfile(flags);
  if (!subject) throw new ConfigError('Which subject? Run: lanes link profile members list');

  const at = config.members.findIndex((member) => member.subject === subject);
  if (at === -1) {
    print(style.dim(`${resolution.profile} does not list ${subject}.`));
    return;
  }

  const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);
  document.removeFrom(['members'], at);
  await document.save();

  const published = nextAfterEdit(await publishProfileEdit({ resolution, config, target }));

  return emit(flags.json, { profile: resolution.profile, subject }, () => {
    announce(resolution);
    print(ok(`${subject} may no longer consume ${style.bold(resolution.profile)}`));

    // The half that is not obvious, and is the difference between this and a
    // session manager. A token already issued keeps working until it expires:
    // membership is read when one is minted, not on every call (ADR-060).
    print(
      style.dim(
        '      A token they already hold keeps working until it expires.\n' +
          `      To close that window now: lanes link token rotate --workspace ${target}`,
      ),
    );
    if (published) print(style.dim(`      ${published}`));
  });
}

/**
 * Whether this workspace may delegate to that subject.
 *
 * The check exists because the alternative is a profile listing a subject
 * nobody can produce a token for — which reads exactly like a working
 * delegation until the person tries to use it.
 */
async function assertDelegatable(
  subject: string,
  target: string,
  signedIn: string | undefined,
): Promise<void> {
  const registry = await readRegistry(resolveWorkspaceRoot());
  const bound = registry[target]?.lanes_workspace;

  if (bound === undefined) {
    // No Lanes workspace behind this one, so there is no membership list to
    // check against and the only subject that can be verified is the one at the
    // keyboard.
    if (subject === signedIn) return;

    throw new ConfigError(
      `Workspace "${target}" is not bound to a Lanes workspace, so it can only delegate to you.\n` +
        '  Add yourself with: lanes link profile members add --me\n' +
        '  To delegate to somebody else, bind the workspace:\n' +
        `    lanes_workspace: <id>   # in lanes-link.yaml, under workspaces.${target}\n` +
        '  Run "lanes auth workspaces" for the ids you belong to.',
    );
  }

  // Bound: the server holds the list, and it is the authority. Not checked here
  // over the network, deliberately — `profile members add` would then fail
  // offline on a workspace that is otherwise entirely local to edit, and the
  // endpoint verifies the subject at token time regardless.
}
