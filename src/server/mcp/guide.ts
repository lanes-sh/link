import { RESERVED_PROVIDER_IDS } from '#connectivity';

/**
 * The long form of what this endpoint is, served as a resource.
 *
 * `initialize.instructions` has a budget it pays on every request forever, so it
 * carries only the habits that must arrive everywhere. This is the document a
 * client reads once when it wants the whole account, and it is served always,
 * without a tool grant, because it describes the surface rather than exposing
 * any of it.
 *
 * **Why a resource rather than a longer `instructions`.** A client caches
 * `initialize` for the life of its registration, so guidance improved after
 * somebody connected never reaches them. A resource is fetched when it is read,
 * so this can be corrected without anybody reconnecting.
 *
 * **No vendor may be named here.** `src/architecture.test.ts` forbids it
 * anywhere under `server/`, and rightly: what an owner has connected is theirs,
 * and prose naming one provider would be wrong for everybody else.
 */

export const GUIDE_URI = 'lanes://instructions';

export const GUIDE_TITLE = 'How this endpoint works';

/**
 * The document.
 *
 * Fixed prose, deliberately: it describes the model rather than this workspace,
 * and the per-principal facts are in `initialize.instructions`, which is
 * computed. Two documents with different lifetimes, and mixing them would make
 * this one wrong the moment a connection was added.
 */
export function guideDocument(): string {
  return `# Lanes Link

One endpoint in front of everything its owner has chosen to expose. It
authenticates, applies permissions per call, and records what happened.

## The three words

**Connection.** One authorised account or store, named \`<provider>.<id>\`. It
belongs to the workspace, so the same account can be reached from more than one
profile without being authorised twice.

**Profile.** A selection of connections, with the capabilities allowed on each,
and the people who may consume it. This is how someone keeps work and personal
apart, and how they hand you one mailbox read-only while another is writable.

**Workspace.** Where connections and profiles live, and which credential store
opens them. You never name one; the endpoint you are talking to is already in it.

## Routing

Every tool takes \`profile\` and \`connection\`. Both are enums, and both are
already narrowed to what you may reach, so anything offered is something you are
allowed to use.

**When it is ambiguous which profile is meant, ask.** Do not default to whichever
is listed first. A profile is a boundary somebody drew on purpose, and crossing
it is the failure this design exists to prevent.

A connection belongs to a profile. Naming one from a different profile is
refused, and the refusal lists what is available where you asked.

## The owner's own material

${RESERVED_PROVIDER_IDS.join(', ')} are not third-party services. They are the
owner's own stores, and each is a connection like any other, so a profile decides
which instances it can reach and what it may do with them.

**Memory and tasks are different stores.** Search memory before concluding you do
not know something about this person or their work. A thing to *do* is a task,
and it has a status; "remember to..." is a task, not a memory. Both are served
back to every later session, so write when asked rather than by habit.

**Skills are the owner's procedures**, surfaced as prompts rather than tools.
That is deliberate: a procedure is selected by the person, not chosen by the
model, and you cannot read one's body. If a task has a skill for it, say so and
let them invoke it rather than improvising your own version.

**Vault values are credentials.** Use one to do the thing that needs it. Do not
quote it back, summarise it, or write it anywhere.

**Entities are the people, companies and projects this owner deals with.** Before
using anyone's address or handle, look them up. A lookup returns every match and
never chooses: more than one means ask which is meant, not take the first.

## What is set up is answerable

Before saying something cannot be reached, or that an account must be added, ask
the setup surface. It reports what exists and what is missing, and it gives the
exact command for the missing thing.

**Running that command is the owner's to do, and inventing one is not.** Every
change to what exists here is a command a person runs; nothing on this surface
adds a connection, edits a profile, or changes who may consume it. That is not an
omission to work around.

## A tool you cannot see may still be reachable

Your list of tools is a snapshot, taken when your client connected. This endpoint
cannot tell you when it changes — it is stateless, so there is no stream on which
to send the notification, and it says so rather than promising one it cannot keep.
Some clients re-read the list each session; some hold the one they first fetched
for as long as they are registered.

So a connection authorised since then is reachable here and absent from your list.
Two tools exist for exactly that, and their names never change, which is what
makes them present in whatever list you were given:

- **Search** finds any capability this endpoint reaches now, by keyword or by its
  exact id, and returns the arguments it takes.
- **Call** invokes one by id, under the same permissions the named tool would
  have had. It reaches nothing you could not otherwise reach, and a capability
  the profile does not allow is refused here exactly as it would be there.

Prefer a named tool wherever your list has one — it is the same call, and your
client can see its schema without asking. Reach for these when you cannot see a
tool for something the owner has plausibly connected, and before concluding that
you cannot do it.

## When a call is refused

A refusal is information, not an obstacle. Three kinds, and they mean different
things:

- **The profile is not available.** You are not a member of it. Nothing you can
  do; its owner adds you.
- **The connection is not part of this profile.** Look at what is, in the enum.
- **The capability is denied.** The profile allows a narrower set than the tool
  suggests. Say what was refused and let the owner decide whether to widen it.

Retrying a refusal unchanged produces the same refusal and one more line in the
owner's audit log.

## Files are named, not carried

Where a tool takes attachments, give a path, an HTTPS URL, or an attachment
already on another message. Do not base64 a file into an argument: it is recorded
in the audit log, and the log is something the owner reads.
`;
}
