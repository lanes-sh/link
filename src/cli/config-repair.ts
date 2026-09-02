import { ConfigDocument } from './config-edit.ts';
import { nextConnectionId } from './identity.ts';

/**
 * Giving a profile a reserved provider it is missing, without undoing a choice.
 *
 * Its own file, apart from `ConfigDocument`, because there are now two callers
 * of the same repair and generalising it in place would have pushed
 * `config-edit.ts` past the file-size budget. The split is along the seam that
 * was already there: that file knows how to *edit* YAML safely, and this one
 * knows what a reserved provider needs to be reachable at all.
 *
 * The owner layer holds no account and is therefore invisible without a
 * connection row nobody would think to write. Every one of them is repaired the
 * same way and the rules below are subtle enough that a second copy would drift
 * — which is the whole reason this is one function taking a provider id rather
 * than several that look alike.
 */

/** Lanes' own provider ids, and the label each row carries. */
const RESERVED_SURFACES = {
  lanes_memory: 'Memory',
  lanes_tasks: 'Tasks',
  lanes_assets: 'Assets',
  lanes_skills: 'Skills',
  lanes_vault: 'Vault',
  lanes_setup: 'Setup',
  lanes_identity: 'Identity',
  lanes_entities: 'Entities',
} as const;

type ReservedSurface = keyof typeof RESERVED_SURFACES;

/**
 * The ones a profile gets whether it asked or not.
 *
 * `identity` is the exception and stays off this list, for the reason
 * `ensureIdentityConnection` gives: a profile with no identity block has nothing
 * for the surface to report, so registering a tool that answers "nothing
 * declared" would spend instructions budget to say so. Everything else here
 * reaches the owner's own material and is empty until they put something in it,
 * which is ADR-050's whole argument — so a profile written before those existed
 * gets them on the next command rather than needing five of its own.
 *
 * `entities` is on the list and `identity` is not, which reads as inconsistent
 * until the test is stated exactly. It is not "is it empty" — memory arrives
 * empty and is granted. It is **can it be filled in from here**: identity is
 * configuration, changed in the CLI under ADR-007, so a surface that reported
 * an empty one could never do anything about it. Entities accumulate on the
 * same surface that reads them, so an empty one is a store waiting to be used
 * rather than a tool with nothing to say (ADR-056).
 *
 * Ordered as `RESERVED_PROVIDER_IDS` is, so a repair reports in the order the
 * template writes and a diff between the two reads as a diff.
 */
export const DEFAULT_SURFACES: readonly ReservedSurface[] = [
  'lanes_memory',
  'lanes_tasks',
  'lanes_assets',
  'lanes_skills',
  'lanes_vault',
  'lanes_setup',
  'lanes_entities',
];

/**
 * What a repair did, split by what a caller does with each half.
 *
 * `connect` reports config edits under `changes` and policy under `granted`,
 * and both are serialised verbatim by `--json` — so an audit asking what a
 * command widened reads only the second, and one blended list of sentences
 * filed the grant as an edit and left prose in a field meant for matching.
 */
export interface SurfaceRepair {
  /** Config edits made, spelled for display. Empty when none were needed. */
  readonly changes: readonly string[];
  /** Allow rules added — patterns, not prose, so a caller can act on them. */
  readonly granted: readonly string[];
}

/**
 * Give a profile one of those surfaces if it does not already have it.
 *
 * A profile that never had the surface has neither the connection row nor the
 * allow rule, and the failure is silent in the worst way: `allowedConnections`
 * returns nothing for a provider with no connection row *before* it consults
 * policy, so the tools are simply absent from `tools/list` with nothing saying
 * why. It is not a hypothetical in either direction — asked what was connected,
 * an agent with no `setup` surface invented a command; and an `identity` block
 * written without the row is a file saying exactly what its owner meant to an
 * agent that cannot see a word of it.
 *
 * Both halves or neither: a connection row without the matching `<provider>.*`
 * rule is as inert as the rule without the row, so adding one alone would look
 * like a fix and change nothing.
 *
 * CLI-side by construction. ADR-007 keeps configuration mutation off the served
 * surface, and a deployed revision holds `objectViewer` on `profiles/`
 * (ADR-023) so it could not write this even if the code let it.
 */
export function ensureReservedConnection(
  connections: ConfigDocument,
  profile: ConfigDocument,
  provider: ReservedSurface,
  options: { grants?: boolean } = {},
): SurfaceRepair {
  // Whether the profile half is written at all. `connect` without `--profile`
  // repairs the workspace's connection rows and touches no profile, because it
  // was not told which one to touch (ADR-057).
  const grants = options.grants ?? true;
  // Raw YAML, so nothing here has been through a schema: this runs over sibling
  // profiles that were never validated, and every field is whatever was typed.
  const workspace = connections.toJSON() as { connections?: unknown } | null;
  const config = profile.toJSON() as { grants?: unknown } | null;

  const rule = `${provider}.*`;
  const covers = (pattern: string): boolean => pattern === '*' || pattern === rule;

  const rows = Array.isArray(workspace?.connections) ? workspace.connections : [];
  const held_grants = Array.isArray(config?.grants) ? config.grants : [];

  // **This profile's own grant comes first.** Any instance of the provider will
  // do, and the *first* one is taken rather than `main` specifically: an
  // operator who renamed theirs should not get a second one bolted on beside
  // it. That reasoning was right and the lookup implementing it was not — it
  // read the workspace's first row, which under contract 2 was this profile's
  // because a profile carried its own connections, and under contract 3 is
  // whichever profile sorts first.
  //
  // So the repair asked whether `personal` granted `memory.main` — demo's — saw
  // that it did not, and set about adding it. For `vault` and `skills` the
  // schema refuses a second grant and the save failed loudly, which is how this
  // was found. For `memory`, `tasks`, `assets`, `setup` and `entities` nothing
  // refuses it, and the profile would quietly have been granted another
  // profile's notes and another profile's task list — the outcome ADR-059
  // exists to prevent, arriving from the repair rather than the migration.
  //
  // **Every** instance, not the first one matched. A profile may grant two —
  // `memory.team` and `memory.personal` — and reading only the first let a deny
  // on the other be stepped around: the repair widened the undenied row and
  // reported the surface granted, which is the one thing the paragraph below
  // says it must never do.
  //
  // `startsWith` rather than slicing at the dot, because these rows are raw
  // unvalidated YAML: `indexOf` answers -1 for a value with no dot at all, and
  // `'vaults'.slice(0, -1)` is `'vault'` — so a typo'd `connection: vaults`
  // matched the vault surface and was widened while the real one stayed
  // unreachable.
  const mine = held_grants.filter((row) => {
    const connection = (row as { connection?: unknown } | null)?.connection;
    return typeof connection === 'string' && connection.startsWith(`${provider}.`);
  }) as { connection?: string; allow?: unknown; deny?: unknown }[];

  // Denied on purpose, and a deny beats an allow — so writing the rule would
  // widen nothing while announcing that an agent can now read the surface,
  // which would be false. Deleting the row no longer removes the surface
  // either, because the next `connect` or `deploy` puts it back; a deny is the
  // way it stays off, so it is the one thing this must not undo.
  //
  // Only a rule covering the whole surface counts. `deny: [setup.provider]` is
  // an operator narrowing it, not switching it off, and that narrowing survives
  // the repair untouched — which is the point of denying one capability.
  if (mine.some((row) => patternsIn(row.deny).some(covers))) return { changes: [], granted: [] };

  // The instance already carrying the rule, if any. Not an early return: the
  // workspace row can be missing while the grant is present — a profile written
  // before the surface existed, repaired once against a `connections.yaml` that
  // has since been hand-edited — and repairing one half only is what this
  // function exists to prevent.
  const allowed = mine.find((row) => patternsIn(row.allow).some(covers));

  // Otherwise the first row that exists and grants nothing is the one to widen.
  const owned = allowed ?? mine[0];

  // Only when this profile grants no instance of the provider at all is the
  // workspace consulted, which is the case this was written for: a surface that
  // did not exist when the profile was written.
  const declared = rows.find(
    (row) => (row as { provider?: unknown } | null)?.provider === provider,
  ) as { id?: unknown } | undefined;

  // The id an existing row already has, else the next free one. Opaque and
  // allocated across the whole workspace, so `lan3` names exactly one row
  // however many surfaces a repair adds in one pass.
  const taken = rows.flatMap((row) => {
    const id = (row as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? [id] : [];
  });
  const id = typeof declared?.id === 'string' ? declared.id : nextConnectionId(taken, true);

  const key = owned?.connection ?? `${provider}.${id}`;

  // Whether the *workspace* needs a row, which is a separate question from
  // which one this profile grants: a profile cannot grant a connection that is
  // not declared, so `owned` implies `declared`.
  const existing = declared;
  const held = owned;

  const changes: string[] = [];
  const granted: string[] = [];

  if (existing === undefined) {
    // Inline, and the allocated id, so a repaired workspace is spelled exactly
    // like `newConnectionsTemplate` writes a fresh one — which is what
    // `config-edit.test.ts` asserts by checking a fresh profile needs no repair.
    // Two spellings of one row is how a template and its repair drift apart.
    connections.addTo(
      ['connections'],
      { id, provider, account: RESERVED_SURFACES[provider] },
      { inline: true },
    );
    changes.push(`connections.yaml += ${key}`);
  }

  if (!grants) return { changes, granted };

  if (held === undefined) {
    profile.addTo(['grants'], { connection: key, allow: [rule], deny: [] }, { inline: true });
    changes.push(`grants += ${key}`);
    granted.push(rule);
  } else if (allowed === undefined) {
    // A row that exists and grants nothing is a surface that is present and
    // silent. Widening it back is the repair; the deny check above is what stops
    // this undoing a deliberate narrowing.
    const at = held_grants.indexOf(held as never);
    profile.addTo(['grants', at, 'allow'], rule, { inline: true });
    granted.push(rule);
  }

  return { changes, granted };
}

/** Whether a repair did anything, without a caller adding up two lists. */
export function repaired(repair: SurfaceRepair): boolean {
  return repair.changes.length > 0 || repair.granted.length > 0;
}

/** The repair as display lines, in the order the two halves are applied. */
export function repairLines(repair: SurfaceRepair): string[] {
  return [...repair.changes, ...repair.granted.map((rule) => `grants[].allow += ${rule}`)];
}

/**
 * The patterns a raw policy list puts *in force*, in either spelling.
 *
 * `policyRuleSchema` takes a bare pattern or `{ capability, expires_at }` and
 * both parse to the same thing, so reading only the string form would re-add a
 * rule the operator had already written with an expiry. Anything that is
 * neither is dropped rather than guessed at: this reads unvalidated YAML, and a
 * malformed rule is for `validateConfig` to report, not for this to interpret.
 *
 * **Expiry is part of the reading.** `evaluate` holds a rule to
 * `expiresAt === undefined || expiresAt > now` (`#policy`), so a lapsed rule
 * grants and denies nothing — and reading the capability alone got both
 * directions wrong. A lapsed *allow* read as live, so the repair wrote the row,
 * skipped the rule, and announced success: the inert half-state this exists to
 * prevent. A lapsed *deny* blocked the repair for good and printed nothing,
 * because having nothing to add is how "already had it" looks.
 *
 * An unparseable date reads as lapsed, which is the safe direction — it adds a
 * working rule rather than trusting a broken one, and the `save` that follows
 * hands the malformed value to `validateConfig`, whose job it is to complain.
 */
function patternsIn(rules: unknown, now = Date.now()): string[] {
  if (!Array.isArray(rules)) return [];

  return rules
    .filter((rule) => {
      const expiry = (rule as { expires_at?: unknown } | null)?.expires_at;
      return typeof expiry !== 'string' || Date.parse(expiry) > now;
    })
    .map((rule) =>
      typeof rule === 'string' ? rule : (rule as { capability?: unknown } | null)?.capability,
    )
    .filter((pattern): pattern is string => typeof pattern === 'string');
}

/**
 * The owner layer, which every profile is expected to have.
 *
 * Was `ensureSetupConnection`, and grew rather than gained siblings: the callers
 * are the same three, and what changed is how many surfaces "a profile should be
 * able to reach its own material" covers. Repairs are accumulated so a caller
 * reports one list — five separate calls would print five near-identical blocks
 * on the one upgrade where any of them fire.
 *
 * Each surface is still decided independently, so a profile that denied exactly
 * one of them keeps that decision while the rest are repaired.
 */
export function ensureOwnerLayer(
  connections: ConfigDocument,
  profile: ConfigDocument,
  options: { grants?: boolean } = {},
): SurfaceRepair {
  const changes: string[] = [];
  const granted: string[] = [];

  for (const provider of DEFAULT_SURFACES) {
    const repair = ensureReservedConnection(connections, profile, provider, options);
    changes.push(...repair.changes);
    granted.push(...repair.granted);
  }

  return { changes, granted };
}

/**
 * The `identity` surface, which only a profile that declares an identity gets.
 *
 * Unlike `setup`, this is *not* repaired by `connect` or `deploy` — a profile
 * with no identity block has nothing for the surface to report, and registering
 * a tool that answers "nothing declared" on every fresh install would spend a
 * paragraph of the instructions budget to say so. `identity add` is the only
 * caller, so the grant arrives exactly when there is something behind it.
 */
export function ensureIdentityConnection(
  connections: ConfigDocument,
  profile: ConfigDocument,
): SurfaceRepair {
  return ensureReservedConnection(connections, profile, 'lanes_identity');
}

