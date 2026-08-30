import { listProfiles } from '#profile';
import { ConfigDocument } from './config-edit.ts';
import { ok, print, style, warn } from './output.ts';

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

/** The reserved provider ids that hold no account, and the label each row carries. */
const RESERVED_SURFACES = {
  memory: 'Memory',
  tasks: 'Tasks',
  assets: 'Assets',
  skills: 'Skills',
  vault: 'Vault',
  setup: 'Setup',
  identity: 'Identity',
  entities: 'Entities',
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
  'memory',
  'tasks',
  'assets',
  'skills',
  'vault',
  'setup',
  'entities',
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
  document: ConfigDocument,
  provider: ReservedSurface,
): SurfaceRepair {
  // Raw YAML, so nothing here has been through a schema: this runs over sibling
  // profiles that were never validated, and every field is whatever was typed.
  const config = document.toJSON() as {
    connections?: unknown;
    policy?: { allow?: unknown; deny?: unknown };
  } | null;

  const rule = `${provider}.*`;
  const covers = (pattern: string): boolean => pattern === '*' || pattern === rule;

  // Denied on purpose, and a deny beats an allow — so writing the rule would
  // widen nothing while announcing that an agent can now read the surface,
  // which would be false. For `setup`, deleting the two lines no longer removes
  // it either, because the next `connect` or `deploy` puts them back; a deny is
  // the way it stays off, so it is the one thing this must not undo. The same
  // holds for `identity`, where the next `identity add` is what would put them
  // back.
  //
  // Only a rule covering the whole surface counts. `deny: [setup.provider]` is
  // an operator narrowing it, not switching it off, and that narrowing survives
  // the repair untouched — which is the point of denying one capability.
  if (patternsIn(config?.policy?.deny).some(covers)) return { changes: [], granted: [] };

  const changes: string[] = [];
  const granted: string[] = [];

  const connections = Array.isArray(config?.connections) ? config.connections : [];
  const declared = (row: unknown): boolean =>
    (row as { provider?: unknown } | null)?.provider === provider;

  if (!connections.some(declared)) {
    // Inline, and `main` for the id, so a repaired profile is spelled exactly
    // like `newProfileTemplate` writes a fresh one. Two spellings of one row is
    // how a template and its repair drift apart.
    document.addTo(
      ['connections'],
      { id: 'main', provider, account: RESERVED_SURFACES[provider] },
      { inline: true },
    );
    changes.push(`connections += ${provider}.main`);
  }

  // `*` already covers it. Re-stating the rule under a blanket allow would be
  // noise in the file and a diff the operator did not ask for.
  if (!patternsIn(config?.policy?.allow).some(covers)) {
    document.addTo(['policy', 'allow'], rule, { inline: true });
    granted.push(rule);
  }

  return { changes, granted };
}

/** Whether a repair did anything, without a caller adding up two lists. */
/** `memory, tasks, assets, skills, vault, setup and entities`, in repair order. */
function listSurfaces(): string {
  const names = [...DEFAULT_SURFACES];
  const last = names.pop();
  return names.length === 0 ? String(last) : `${names.join(', ')} and ${last}`;
}

export function repaired(repair: SurfaceRepair): boolean {
  return repair.changes.length > 0 || repair.granted.length > 0;
}

/** The repair as display lines, in the order the two halves are applied. */
export function repairLines(repair: SurfaceRepair): string[] {
  return [...repair.changes, ...repair.granted.map((rule) => `policy.allow += ${rule}`)];
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
export function ensureOwnerLayer(document: ConfigDocument): SurfaceRepair {
  const changes: string[] = [];
  const granted: string[] = [];

  for (const provider of DEFAULT_SURFACES) {
    const repair = ensureReservedConnection(document, provider);
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
export function ensureIdentityConnection(document: ConfigDocument): SurfaceRepair {
  return ensureReservedConnection(document, 'identity');
}

/**
 * Apply that repair across a workspace, saving and reporting what changed.
 *
 * Here rather than in `#deployments`, where it was, because `start` needs it as
 * much as `deploy` does — more, in fact: `start` is the one command an existing
 * install runs without being asked to, so it is the path by which a profile
 * written before ADR-050 gets the layer at all. Two copies of a function that
 * widens a policy is not a thing to have.
 *
 * **The caller scopes it**, and for `deploy` that is exactly the set being
 * uploaded: a profile it sends is a profile the endpoint will serve, so
 * repairing a narrower set would leave a served profile without the surfaces.
 * Note what a `--profile` flag does not mean — it is the flag alone, so a
 * profile resolved from the environment leaves it undefined and that reads as
 * the whole workspace.
 *
 * *Which files are profiles* comes from `listProfiles`, never from an allowlist
 * of what is safe to copy: that would happily hand over a committed
 * `personal.example.yaml` or a nested `profiles/archive/old.yaml`, and this
 * opens and validates what it is given — which once turned a template into a
 * `ConfigError` aborting a deploy after provisioning had made cloud resources.
 *
 * A profile that cannot be read is warned about rather than fatal: the repair is
 * a courtesy on the way past, and the caller's real work should still happen.
 * Not silent, though — nothing else widens a policy without being asked.
 *
 * CLI-side by construction, like everything else in this file: a deployed
 * revision holds `objectViewer` on `profiles/` (ADR-023) and could not write
 * this even if the code let it.
 */
export async function repairOwnerLayer(
  workspaceRoot: string,
  profiles: readonly string[] | undefined,
  options: { report?: (line: string) => void } = {},
): Promise<void> {
  // stdout by default, because every caller but one is printing a report a
  // person reads. `update --json` passes `progress` instead: what it produces is
  // a document, and a line of prose in front of it corrupts whatever is parsing.
  // Routed rather than silenced — nothing else here widens a policy without
  // saying so, and this must not be the exception.
  const say = options.report ?? print;
  const wanted = profiles === undefined ? undefined : new Set(profiles);

  for (const name of await listProfiles(workspaceRoot)) {
    if (wanted !== undefined && !wanted.has(name)) continue;

    try {
      const document = await ConfigDocument.open(workspaceRoot, name);
      const repair = ensureOwnerLayer(document);
      if (!repaired(repair)) continue;

      await document.save();

      say(ok(`gave ${style.bold(name)} its own owner layer`));
      for (const change of repairLines(repair)) say(`      ${style.dim(change)}`);
      // Built from `DEFAULT_SURFACES` rather than typed out. The typed-out
      // version still named six after a seventh had been added, so a person
      // watching a deploy was told entities had arrived on the line above and
      // that the layer was six things on the line below.
      say(`      ${style.dim(`${listSurfaces()} — your own material, no account behind any of them`)}`);
    } catch (error) {
      say(
        warn(
          `could not give ${name} its owner layer: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        ),
      );
    }
  }
}
