import { print } from '../../output.ts';

/**
 * `lanes link mcp install-instructions` — the block a client should be told once.
 *
 * A registration points a client at this endpoint. It does not tell the *model*
 * anything, and the model is what decides whether to look here at all. The
 * common failure is not a client that cannot reach the endpoint; it is one that
 * can and answers from nothing anyway, because reaching for a tool is a habit
 * and no habit is installed by adding a server to a config file.
 *
 * So this prints a short block for a person to paste into whatever their client
 * treats as durable instruction — a project file, a custom instruction, a
 * memory. It says where things are and what to read first, and nothing else:
 * the full account lives at `lanes://instructions` and is served by the
 * endpoint, so it can be corrected without anybody pasting anything again.
 *
 * **Printed rather than written.** Every client keeps this somewhere different
 * and several keep it somewhere a person curates by hand. Writing into one of
 * those is the class of thing ADR-016 puts on the other side of the line from
 * `mcp add`: delegate where the harness owns a command, write the file only
 * where it does not, and where neither is true, hand over the text.
 */

/** What each client calls the place this belongs, so the hint is actionable. */
const WHERE: Record<string, string> = {
  claude: 'CLAUDE.md in your project, or ~/.claude/CLAUDE.md for every project',
  chatgpt: "Settings → Personalization → Custom instructions, under 'anything else'",
  codex: 'AGENTS.md in your project, or ~/.codex/AGENTS.md',
  cursor: '.cursor/rules/ in your project',
};

export interface InstallInstructionsFlags {
  readonly client?: string | undefined;
}

export function installInstructions(flags: InstallInstructionsFlags = {}): void {
  const client = flags.client?.toLowerCase();

  if (client !== undefined && !(client in WHERE)) {
    throw new Error(
      `Unknown client "${client}". Known: ${Object.keys(WHERE).join(', ')}.\n` +
        '  Omit --client for the block on its own.',
    );
  }

  if (client !== undefined) {
    // To stderr, so the block on stdout stays pasteable. Somebody piping this
    // into a file wants the text and not the advice about where to put it.
    process.stderr.write(`Paste this into ${WHERE[client]}:\n\n`);
  }

  print(BLOCK);
}

/**
 * The block itself.
 *
 * Deliberately short and deliberately not a copy of the endpoint's own
 * instructions. It exists to establish one habit — look here before answering
 * from nothing — and to name the document that carries the rest. A longer block
 * pasted into a project file is one that goes stale in a place nobody will
 * think to update.
 *
 * No vendor names and no account details, for the same reason nothing under
 * `server/` may carry one: what the owner connected is theirs.
 */
const BLOCK = `## Lanes Link

Lanes Link is the route to my accounts, my memory, my notes, my saved procedures
and my contacts. It is an MCP endpoint, and it is already connected.

- Before saying you do not know something about me or my work, search memory.
- Before using anyone's address or handle, look them up in entities. It returns
  every match and never picks one; if there is more than one, ask me.
- A thing for me to do is a task, not a memory. Tasks have a status.
- If I have a saved procedure for something, tell me it exists and let me run it
  rather than improvising your own version.
- Before telling me something cannot be reached or that an account is missing,
  ask the setup surface. It reports what exists and gives the exact command for
  what does not. Run nothing yourself: every change here is mine to make.
- Read \`lanes://instructions\` before your first call for the full account of
  how routing, profiles and refusals work.

Every tool takes a profile. A profile is how I keep things apart, so when it is
ambiguous which one I mean, ask rather than picking the first.`;
