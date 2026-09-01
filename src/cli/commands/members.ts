import { readSession } from '#auth/lanes/session.ts';
import { recordConfigChange } from '../audit-change.ts';
import {
  ConfigError,
  readRegistry,
  resolveTargetWorkspace,
  resolveWorkspaceRoot,
} from '#profile';
import { ConfigDocument } from '../config-edit.ts';
import { describeMember, workspaceMembers } from '#auth/lanes/members.ts';
import { announce, emit, heading, ok, print, style, table, warn } from '../output.ts';
import { nextAfterEdit, publishProfileEdit } from '../publish.ts';
import { resolveProfile, type GlobalFlags } from '../runtime.ts';

/**
 * `lanes link profile members` — who may consume a profile (ADR-060).
 *
 * CLI-only, like everything that authorises future agent behaviour (ADR-007),
 * and for the sharpest version of that argument: an agent able to edit this
 * could add itself.
 *
 * **This is a selection from the Lanes workspace, not a list beside it.**
 * Membership is managed on the dashboard — invited, accepted, given a role,
 * removed — and a workspace bound with `lanes_workspace:` is asked who it holds.
 * Somebody added there shows up here the moment they accept, and granting them a
 * profile is a local edit naming a subject the server already vouches for.
 *
 * For `local` there is no such list, so the only subject accepted is the
 * signed-in one — a local workspace delegating to a stranger is a typo, not a
 * use case.
 */

export interface MemberRow {
  readonly subject: string;
  readonly role: 'owner' | 'member';
  /** Whether this is the identity running the command. */
  readonly you: boolean;
}

export async function membersList(flags: GlobalFlags & { json?: boolean }): Promise<void> {
  const { resolution, config, target } = await resolveProfile(flags);
  const session = await readSession();

  const rows: MemberRow[] = config.members.map((member) => ({
    subject: member.subject,
    role: member.role,
    you: member.subject === session?.subject,
  }));

  // The workspace's own people, so this listing answers both halves of the
  // question: who may use this profile, and who *could* be given it. Without
  // the second, adding somebody means going to the dashboard to copy a subject
  // out of it.
  const held = await workspaceMembers(await boundWorkspace(target));
  const granted = new Set(rows.map((row) => row.subject));
  const available = held.members.filter(
    (member) => member.subject === null || !granted.has(member.subject),
  );

  return emit(
    flags.json,
    { profile: resolution.profile, members: rows, available: available },
    () => {
      announce(resolution);

      if (rows.length === 0) {
        // Empty is nobody, and saying so matters: the natural reading of a blank
        // list is "no restriction", which is the opposite of what it means.
        print(style.dim('No members. Nobody may consume this profile.'));
        print(style.dim('  Add yourself with: lanes link profile members add --me'));
      } else {
        heading(`May consume ${resolution.profile} (${rows.length})`);
        table(
          rows.map((row) => [
            `  ${style.bold(row.subject)}`,
            row.role,
            row.you ? style.dim('you') : '',
          ]),
        );
      }

      if (available.length > 0) {
        heading(`In the workspace, not granted (${available.length})`);
        table(
          available.map((member) => [
            `  ${style.bold(describeMember(member))}`,
            member.role,
            member.status === 'pending'
              ? style.dim('invitation not accepted')
              : style.dim(member.subject ?? ''),
          ]),
        );
      }

      if (held.unavailable !== null && held.unavailable !== 'this workspace is not bound to a Lanes workspace') {
        print('');
        print(style.dim(`Could not list the workspace's members: ${held.unavailable}`));
      }
    },
  );
}

/** The Lanes workspace this one is bound to, if any. */
async function boundWorkspace(target: string): Promise<string | undefined> {
  // **The workspace that declares the target, which is not this machine once it
  // is deployed.** `lanes_workspace` is a declaration field, and
  // `recordDeployment` writes the declaration into the bucket while leaving
  // this machine a pointer carrying only `at`, `primary` and the deploy stamps.
  // So reading it here found nothing the moment a target was deployed: binding
  // a workspace stopped taking effect, `members add` refused everyone but the
  // person at the keyboard, and the remedy it printed — add `lanes_workspace:`
  // under `workspaces.<target>` — named the pointer entry, which the next
  // deploy overwrites. A declaration resolves back to this root unchanged.
  const local = resolveWorkspaceRoot();
  const registry = await readRegistry(await resolveTargetWorkspace(local, target).catch(() => local));
  return registry[target]?.lanes_workspace;
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

  await recordConfigChange(
    config,
    resolution.workspaceRoot,
    target,
    {
      capability: 'config.member.add',
      scope: resolution.profile,
      arguments: { subject: wanted, role },
    },
    (note) => print(warn(note)),
  );

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

  await recordConfigChange(
    config,
    resolution.workspaceRoot,
    target,
    { capability: 'config.member.remove', scope: resolution.profile, arguments: { subject } },
    (note) => print(warn(note)),
  );

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
 *
 * Bound to a Lanes workspace, the answer is the workspace's own member list:
 * somebody added on the dashboard is delegatable here, and nobody else is.
 * Unbound, there is no list to ask, so the only verifiable subject is the one at
 * the keyboard.
 */
async function assertDelegatable(
  subject: string,
  target: string,
  signedIn: string | undefined,
): Promise<void> {
  const bound = await boundWorkspace(target);

  if (bound === undefined) {
    if (subject === signedIn) return;

    throw new ConfigError(
      `Workspace "${target}" is not bound to a Lanes workspace, so it can only delegate to you.\n` +
        '  Add yourself with: lanes link profile members add --me\n' +
        '  To delegate to somebody else, bind the workspace:\n' +
        `    lanes_workspace: <id>   # in lanes-link.yaml, under workspaces.${target}\n` +
        '  Run "lanes auth workspaces" for the ids you belong to.',
    );
  }

  const held = await workspaceMembers(bound);

  // Unreachable rather than empty. Refusing on a network failure would make a
  // local edit depend on our uptime, and the endpoint verifies the subject when
  // it mints a token regardless — so this warns and proceeds.
  if (held.unavailable !== null) {
    print(
      style.dim(
        `  Could not check the workspace's members (${held.unavailable}), so this was not verified.`,
      ),
    );
    return;
  }

  const match = held.members.find((member) => member.subject === subject);
  if (match !== undefined) return;

  // A pending invitation is the interesting refusal: the person exists, the
  // operator can see them on the dashboard, and there is still no subject to
  // write down. Saying "not a member" would send them to add somebody who is
  // already there.
  const pending = held.members.filter((member) => member.status === 'pending');

  throw new ConfigError(
    `${subject} is not a member of the Lanes workspace behind "${target}".\n` +
      (held.members.length > 0
        ? `  It holds: ${held.members.map(describeMember).join(', ')}\n`
        : '  It holds nobody yet.\n') +
      (pending.length > 0
        ? `  ${pending.map(describeMember).join(', ')} ${pending.length === 1 ? 'has' : 'have'} not ` +
          'accepted the invitation yet, so there is no subject for them to be granted.\n'
        : '') +
      '  Invite them on the dashboard first: https://lanes.sh/dashboard/settings/members',
  );
}
