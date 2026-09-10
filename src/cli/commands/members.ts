import { readSession } from '#auth/lanes/session.ts';
import { recordConfigChange } from '../audit-change.ts';
import {
  ConfigError,
  readRegistry,
  resolveTargetWorkspace,
  resolveWorkspaceRoot,
} from '#profile';
import { ConfigDocument } from '../config-edit.ts';
import { describeMember, workspaceMembers, type WorkspaceMember } from '#auth/lanes/members.ts';
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
 * **A profile holds uids, and this is the list.** An admin attaches one; the
 * endpoint checks on every request that the uid calling it is on the profile
 * (`mayReach`). That is the whole model, and there is nothing else to
 * establish here — no roster to clear, no email to resolve, no workspace to
 * bind first.
 *
 * A bound Lanes workspace is still *read*, because it is the only thing that
 * can tell the operator something useful: `membersList` shows who is in the
 * workspace and not yet granted, so adding somebody does not mean going to the
 * dashboard to copy a uid out of it. What it no longer does is decide. See
 * `assertDelegatable` for the four reasons it stopped.
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
  // So reading it from the pointer found nothing the moment a target was
  // deployed — and back when absence was a refusal, that made binding a
  // workspace stop taking effect on exactly the workspaces it mattered for. A
  // declaration resolves back to this root unchanged.
  //
  // Nothing depends on the answer any more except what is *shown*, which is why
  // the field having no CLI that writes it is now a gap rather than a wall.
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

  await assertMayManage(target, session?.subject);
  await assertDelegatable(wanted, target, session?.subject);

  const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);
  document.addTo(['members'], { subject: wanted, role }, { inline: true });
  await document.save();

  await recordConfigChange(
    config.instance.profile,
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

  await assertMayManage(target, (await readSession())?.subject);

  const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);
  document.removeFrom(['members'], at);
  await document.save();

  await recordConfigChange(
    config.instance.profile,
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
 * Whether the person at the keyboard may edit who a profile lists.
 *
 * **Workspace `admin` may; `editor` may not.** The roles come from the Lanes
 * workspace this one is bound to, which is where they are already managed,
 * rather than from a second role system beside `members:` — the argument
 * `memberSchema` makes for its own `role` field gating nothing.
 *
 * **This is intent rather than a boundary, and saying so is the point.**
 * `members:` is a line in a YAML file, and anybody who can run this command can
 * also open that file in an editor. What the check buys is that widening your
 * own reach has to be deliberate rather than a command you happened to be
 * allowed to run, and that the refusal names somebody who can do it for you.
 * The boundary that holds is who may write the workspace's files: an IAM grant
 * on a deployed workspace, the machine on a local one.
 *
 * Unbound, there is no list to ask and no roles to read, and `assertDelegatable`
 * already refuses everybody but the person signed in.
 */
async function assertMayManage(target: string, signedIn: string | undefined): Promise<void> {
  const bound = await boundWorkspace(target);
  if (bound === undefined) return;

  const held = await workspaceMembers(bound);

  // Warned about and allowed, exactly as `assertDelegatable` treats the same
  // failure and for the same reason: a local edit must not depend on our uptime.
  if (held.unavailable !== null) return;

  const refusal = manageRefusal(held.members, signedIn, target);
  if (refusal !== null) throw new ConfigError(refusal);
}

/**
 * The decision, without the network in front of it.
 *
 * Split out so it can be tested: everything above it is a session read and an
 * HTTP call, and everything in it is the rule. `null` means go ahead.
 *
 * A subject the workspace does not list at all is **not** refused here. It is
 * the ordinary state of a workspace whose list could not name you — a local one
 * bound to an id you belong to under a different account, say — and
 * `assertDelegatable` is the check that has an answer for it. Refusing twice
 * for one cause produces the worse of the two messages.
 */
export function manageRefusal(
  members: readonly WorkspaceMember[],
  signedIn: string | undefined,
  target: string,
): string | null {
  const me = members.find((member) => member.subject === signedIn);
  if (me === undefined || me.role === 'admin') return null;

  const admins = members.filter((member) => member.role === 'admin');

  return (
    `Editing who may consume a profile is for admins of the Lanes workspace behind "${target}", ` +
    `and you are ${me.role} there.\n` +
    (admins.length > 0
      ? `  Ask one of: ${admins.map(describeMember).join(', ')}\n`
      : '  It lists no admin, which is a workspace problem rather than a profile one.\n') +
    '  Unchanged: everything inside the profiles that already list you.'
  );
}

/**
 * Whether this workspace may delegate to that subject.
 *
 * **A well-formed subject is delegatable, and that is the whole rule.** An
 * admin attaches a uid to a profile; the endpoint then checks, on every
 * request, that the uid calling it is on that profile. There is no third thing
 * to establish here.
 *
 * It used to refuse. Unbound, only the signed-in subject was accepted; bound,
 * only a subject on the Lanes workspace's own roster. Both are gone, and the
 * reasons they went are worth recording because each looked like a safety
 * property:
 *
 *  - **It was not a boundary.** ADR-079 says so plainly — `members:` is a line
 *    in a YAML file and anybody who can run this command can open that file in
 *    an editor. The boundary is who may write the workspace's files: an IAM
 *    grant on a deployed workspace, the machine on a local one.
 *  - **The shape is already checked, twice over.** `subjectRef` is
 *    `/^lanes:[A-Za-z0-9]{6,64}$/`, which is also what stops a pasted
 *    credential landing in this field — `secret-detection.ts` refuses a bare
 *    28-character blob, and the `lanes:` prefix is what takes a real subject
 *    out of that class (`profile/primitives.ts`).
 *  - **A wrong uid is inert.** It writes a row nothing can ever match: no
 *    assertion names that subject, so no token is ever minted for it. A dead
 *    row, not a hole.
 *  - **The remedy it printed did not exist.** The refusal told the operator to
 *    add `lanes_workspace: <id>` under `workspaces.<target>` in
 *    `workspaces.yaml`. Nothing in the CLI writes that field, and for a
 *    deployed target that file is an object in the bucket rather than the
 *    pointer on this machine — so the way out of the refusal was to hand-edit
 *    GCS.
 *
 * What the roster is still good for is telling the operator something. Bound,
 * `membersList` shows who is in the workspace and not yet granted, and a
 * subject absent from it gets a warning here — because the likeliest reason for
 * that is a typo, and a typo is exactly what the inert row above reads like.
 */
async function assertDelegatable(
  subject: string,
  target: string,
  signedIn: string | undefined,
): Promise<void> {
  if (subject === signedIn) return;

  const bound = await boundWorkspace(target);
  if (bound === undefined) return;

  const held = await workspaceMembers(bound);

  // Unreachable rather than empty, and it says nothing either way. Warning on a
  // network failure would teach the operator to ignore this line.
  if (held.unavailable !== null) return;

  const note = delegationNote(held.members, subject, target);
  if (note !== null) print(style.dim(note));
}

/**
 * What to say about a subject the bound workspace does not list. `null` to say
 * nothing.
 *
 * Split out so it can be tested, exactly as `manageRefusal` is and for the same
 * reason: everything above it is a session read and an HTTP call, and
 * everything in it is the rule. The difference from `manageRefusal` is that
 * this one never refuses — it is a note, because the likeliest cause is a typo
 * and the second likeliest is a uid from somewhere this workspace cannot see.
 */
export function delegationNote(
  members: readonly WorkspaceMember[],
  subject: string,
  target: string,
): string | null {
  if (members.some((member) => member.subject === subject)) return null;

  // A pending invitation is the interesting case: the person exists, the
  // operator can see them on the dashboard, and they have no uid yet — so a row
  // naming a guess looks like a working delegation until they try to use it.
  const pending = members.filter((member) => member.status === 'pending');

  return (
    `warn  ${subject} is not in the Lanes workspace behind "${target}", so this was\n` +
    '      not verified. It is written either way — check it, because nothing can\n' +
    '      mint a token for a subject that does not exist.' +
    (pending.length > 0
      ? `\n      ${pending.map(describeMember).join(', ')} ` +
        `${pending.length === 1 ? 'has' : 'have'} not accepted an invitation yet, so\n` +
        '      there is no uid for them to be granted.'
      : '')
  );
}
