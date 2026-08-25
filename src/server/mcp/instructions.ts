import { RESERVED_PROVIDER_IDS } from '#connectivity';
import type { MergedCapability } from './visibility.ts';

/**
 * What the endpoint says about itself, in the `initialize` response.
 *
 * A client that has just connected holds sixty tools with good individual
 * descriptions and no account of what the thing *is* — that there is memory
 * worth consulting before answering from nothing, that a skill is the owner's
 * own procedure rather than a suggestion, that `profile` is how someone keeps
 * work and personal apart and is therefore never a field to guess at. Every one
 * of those is a habit, and a habit does not fit in a tool description.
 *
 * MCP has one field for this and we were not using it. It is the only channel
 * that reaches a client with no skills directory and no config we may write —
 * so it carries the part that must arrive everywhere, and the bundled skill
 * carries the longer form for the two harnesses that can hold one.
 *
 * **Generated, not written.** The prose below is fixed; the facts under it are
 * this principal's, computed from the same policy-filtered set the tools were
 * registered from. It is rebuilt per request over HTTP, so it cannot describe a
 * profile that has gone away or omit one that was added.
 *
 * Two constraints on editing it:
 *
 * - **Length is a recurring cost.** This lands in the system prompt of every
 *   session, so a paragraph added here is paid for on every request forever.
 *   `instructions.test.ts` holds a budget.
 * - **No vendor may be named.** `src/architecture.test.ts` forbids it anywhere
 *   under `server/`, and rightly: the list below is whatever the owner has
 *   connected, and prose that named one would be wrong for everybody else.
 */

/**
 * The habits, in the order they are needed.
 *
 * Routing first because it gates every call; the two ways a call ends badly last,
 * because that is when an agent is most tempted to improvise. Second person, and
 * specific about what *not* to do — "ask which profile" is advice, "do not
 * default to the first" is a rule.
 *
 * **Four of these are conditional**, and that is a correctness property rather
 * than a saving. This used to be one fixed string that told every client to
 * consult memory, invoke skills, and guard vault values — on an endpoint
 * granting none of the three, which is the common case for a workspace that
 * connected a mailbox and nothing else. Prose describing tools that are not
 * there is worse than absent prose: it is a promise the tool list contradicts,
 * and an agent resolves that by guessing. The saving is real too, and it is
 * what pays for `SETUP` fitting inside the budget below.
 *
 * The opening no longer enumerates what is here for the same reason. The
 * listing at the end says what is reachable, computed rather than asserted.
 */
const OPENING = `This endpoint is one place to reach what its owner has chosen to expose. It
authenticates, applies permissions, and records what happened, so you do not
have to.`;

const ROUTING = `**Routing.** Every tool takes \`profile\` and \`connection\`. A profile is how
someone separates work from personal — when it is ambiguous which one is meant,
ask. Do not default to whichever is listed first.`;

const MEMORY = `**Memory is worth consulting.** Before concluding you do not know something
about this person or their work, search it. Writing to memory is a separate
grant, and what you write is served back to every later session — including to
a different agent — so write when asked to remember something, not by habit.`;

const SKILLS = `**Skills are the owner's procedures**, surfaced as prompts rather than tools.
That is deliberate: a procedure is selected by the person, not chosen by the
model, and you cannot read one's body. They belong to one profile, so a skill
you saw under one is not available under another. If a task has a skill for it,
say so and let them invoke it rather than improvising your own version.`;

const VAULT = `**Vault values are credentials.** Use one to do the thing that needs it. Do not
quote it back, summarise it, or write it anywhere.`;

/**
 * The one that exists because its absence was observed, not predicted.
 *
 * Asked to connect a second mailbox, a client with no setup surface and no
 * skill answered that it could not and then invented the procedure — edit the
 * profile YAML, run "the auth command" — neither of which is a thing. It had
 * no way to know `setup_overview` answers exactly that, so the instruction has
 * to arrive here: this is the only channel that reaches a client which has
 * merely been pointed at the URL.
 */
const SETUP = `**What is set up is answerable.** Before saying something cannot be reached, or
that an account must be added, call \`setup_overview\` — then \`setup_provider\`
for the exact command. Running it is the owner's to do; inventing it is not.`;

const FILES = `**Files are named, not carried.** Where a tool takes attachments, give a path, an
HTTPS URL, or an attachment already on another message; the endpoint reads the
bytes. Never encode a file into a call — that is the thing this replaces.`;

const REFUSAL = `**A refused call is the permission system working**, not an obstacle to route
around. Report what was refused and let the owner decide whether to widen it.
Every call, including a refused one, is recorded.`;

/**
 * The one about not reaching here at all.
 *
 * Only for a client that authorises against this endpoint over the network —
 * the one that cannot be handed the bundled skill, and the one whose connector
 * decides on its own whether this endpoint is available. Observed: with the
 * endpoint up and idle, a connector reported it unreachable without issuing a
 * request at all, and the model read that as a fault, then re-derived an answer
 * it had already given and re-composed an entry it had already written. Nothing
 * here can prevent it, because nothing here is consulted — the call never
 * arrives. Telling the model what the state means is the whole of what is left.
 *
 * Deliberately *not* "the endpoint is asleep". Usually it is not, and prose
 * asserting a cause the model cannot check is how a wrong diagnosis gets
 * repeated with confidence.
 */
const AVAILABILITY = `**A call may simply not go through.** This endpoint is one machine its owner
runs, and a client can report it unreachable while it is up. That is ordinary —
not a fault to diagnose, and not authorization you have lost. Say the call did
not land, do not redo what already succeeded, and offer to retry.`;

/** Which paragraph each owner-layer provider brings, when it is reachable. */
const OWNER_HABITS: Record<string, string> = {
  memory: MEMORY,
  skills: SKILLS,
  vault: VAULT,
  setup: SETUP,
};

/**
 * The whole string's ceiling, and the only budget there is.
 *
 * This lands in the system prompt of every session against this endpoint, so a
 * paragraph added here is paid for on every request forever. Needing to raise
 * it is the prompt to ask whether the paragraph belongs in the skill instead,
 * where it is loaded only when relevant.
 *
 * It was raised once, from 2000, for `AVAILABILITY` — and that question was
 * asked and answered the other way: the client that paragraph exists for is
 * precisely the one that holds no skills directory, so the skill is not a place
 * it can go. Only an endpoint serving remote clients spends it.
 *
 * Exported because the test asserted `2000` as a literal while the code
 * reserved room against a second, differently-derived number — so the two could
 * disagree, and did. There is no separate listing allowance any more: `spent`
 * measures the prose that was actually assembled, and `spent + form.length` is
 * exactly the final length, because `join` adds the same two characters the
 * reduce already counted.
 */
export const MAX_INSTRUCTIONS = 2300;

/** Which of the owner-layer providers this principal can actually reach. */
function ownerProviders(merged: ReadonlyMap<string, MergedCapability>): string[] {
  const present = new Set<string>();

  for (const id of merged.keys()) {
    const provider = id.slice(0, id.indexOf('.'));
    if (RESERVED_PROVIDER_IDS.includes(provider)) present.add(provider);
  }

  return RESERVED_PROVIDER_IDS.filter((id) => present.has(id));
}

/**
 * The connections each profile contributes, deduplicated.
 *
 * Taken from `merged` rather than from each profile's config, so it lists what
 * is *reachable* rather than what is configured. A connection the principal has
 * no grant for is not registered on any tool, and announcing it here would
 * describe a door that does not open.
 */
function connectionsByProfile(
  profiles: readonly string[],
  merged: ReadonlyMap<string, MergedCapability>,
): Map<string, string[]> {
  const found = new Map<string, Set<string>>();

  for (const entry of merged.values()) {
    for (const [profile, connections] of entry.reachable) {
      const known = found.get(profile) ?? new Set<string>();
      for (const connection of connections) known.add(connection);
      found.set(profile, known);
    }
  }

  // Ordered by the served list rather than by discovery, so the listing is
  // stable between requests and reads the same as everywhere else.
  const listed = new Map<string, string[]>();
  for (const profile of profiles) {
    const known = found.get(profile);
    if (known) listed.set(profile, [...known].sort());
  }

  return listed;
}

/**
 * Profile *names*, not runtimes: this needs the order they are served in and
 * nothing else, and a signature that asked for more would imply it reads more.
 */
export function serverInstructions(
  profiles: readonly string[],
  merged: ReadonlyMap<string, MergedCapability>,
  /** Whether a client authorises against this endpoint rather than being handed
   * a token — see `AVAILABILITY`, the only paragraph that reads it. */
  remoteClients = false,
): string {
  const reachable = connectionsByProfile(profiles, merged);
  const owner = ownerProviders(merged);

  // Assembled per principal, because the owner layer is granted per principal.
  // `ownerProviders` is already ordered by `RESERVED_PROVIDER_IDS`, so the
  // paragraphs keep one order between requests rather than discovery order.
  const sections = [
    OPENING,
    ROUTING,
    ...owner.map((id) => OWNER_HABITS[id]).filter((habit): habit is string => habit !== undefined),
    FILES,
    REFUSAL,
    ...(remoteClients ? [AVAILABILITY] : []),
  ];

  if (reachable.size === 0) {
    // Not an error state worth hiding: a workspace with no connection yet, or a
    // principal granted nothing, both land here, and saying so beats a heading
    // with nothing under it.
    sections.push(
      'Nothing is reachable through this endpoint yet — no connection is both configured and permitted.',
    );
    return sections.join('\n\n');
  }

  const lines = [...reachable].map(
    ([profile, connections]) => `  ${profile}: ${connections.join(', ')}`,
  );
  const listing = `Reachable now, by profile:\n${lines.join('\n')}`;

  // The prose above varies per principal; this listing grows with the workspace.
  // Either can be the half that does not fit, so all three widths are measured
  // against the one ceiling rather than against a reserve guessed in advance —
  // which is how a workspace of one profile and one mailbox ended up being told
  // "1 profiles" with a hundred characters of the budget unspent.
  //
  // Summarising rather than truncating, and safe to do: every tool carries the
  // connections it accepts in its own `connection` enum, which is the
  // authoritative list. This paragraph is orientation, so a count and the profile
  // names lose nothing an agent cannot get exactly.
  const total = [...reachable.values()].reduce((sum, list) => sum + list.length, 0);
  const names = [...reachable.keys()];
  const tail = "Each tool's `connection` argument lists the ones it accepts.";
  const plural = names.length === 1 ? 'profile' : 'profiles';

  // Widest first. The last is bounded — it names no profile — which is what
  // makes the ceiling hold for a workspace of any size.
  const forms = [
    listing,
    `Reachable now: ${total} connections across ${names.join(', ')}. ${tail}`,
    `Reachable now: ${total} connections across ${names.length} ${plural}. ${tail}`,
  ];

  const spent = sections.reduce((count, section) => count + section.length + 2, 0);

  // Every candidate is checked, including the last: it is shorter than naming
  // twenty profiles but not shorter than naming one, so choosing it unmeasured
  // both overran the budget in one direction and wasted it in the other. If
  // nothing fits, the shortest is the most honest thing left to say.
  sections.push(
    forms.find((form) => spent + form.length < MAX_INSTRUCTIONS) ??
      forms.reduce((shortest, form) => (form.length < shortest.length ? form : shortest)),
  );

  // No trailing "the owner's own material is here too, under: …" line any more.
  // Each of those providers now brings its own paragraph when it is reachable,
  // so the list repeated what the prose had just said — and it swept `setup`
  // in with memory, skills and vault, which it is not: it holds none of the
  // owner's material and only describes what the others are.
  return sections.join('\n\n');
}
