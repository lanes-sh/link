import { newConnectionsTemplate } from './config-templates.ts';
import { applyMoves, planMoves, type Move } from './contract3-data.ts';
import {
  mergeCredentials,
  planCredentials,
  refRenames,
  type CredentialPlan,
} from './contract3-credentials.ts';
import { parseDocument } from 'yaml';
import {
  CONNECTIONS_FILE,
  ConfigError,
  DATA_DIR,
  WORKSPACE_FILE,
  layout,
  listProfiles,
  readWorkspaceFile,
  workspaceFiles,
  writeWorkspaceFile,
} from '#profile';
import { RESERVED_PROVIDER_IDS } from '#connectivity';
import { ConfigDocument } from './config-edit.ts';
import { grantsFor, hoistConnections } from './contract3-shape.ts';

/**
 * Contract 2 to contract 3: connections move out of the profile.
 *
 * The hardest migration this project has done, and the one it could least
 * afford to skip. `layout.ts` and ADR-030 both set the precedent that there is
 * no migration, because machinery to move an old layout is more code than the
 * thing it moves and has to keep working forever. That precedent was set for
 * *empty directories*. Here the thing being moved is every credential the
 * operator holds, and "re-authorise fifteen accounts in a browser" is not a
 * release note anyone should write.
 *
 * Four moves, in an order chosen so a crash between any two leaves a workspace
 * that still opens:
 *
 *   1. Connections are hoisted into `connections.yaml`.
 *   2. Credentials are merged into one store, and read back before the old ones
 *      are touched.
 *   3. Profiles are rewritten, `grants:` being the old connections crossed with
 *      the old flat policy, which is exactly what contract 2 meant.
 *   4. Bytes move to their connection-keyed homes.
 *
 * The registry rename rides along at the end, because it is the one step that
 * cannot half-apply: it is a single document.
 */

/** What a divergent id was renamed to, and why. */
export interface ContractRename {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface Contract3Migration {
  readonly workspaceRoot: string;
  readonly profiles: readonly string[];
  readonly connections: readonly string[];
  readonly renames: readonly ContractRename[];
  readonly credentials: readonly string[];
  readonly moved: readonly string[];
  readonly changes: readonly string[];
  readonly alreadyCurrent: boolean;
}

export interface LegacyConnection {
  readonly id: string;
  readonly provider: string;
  readonly account: string;
  readonly label?: string;
  readonly credential_ref?: string;
  readonly config?: Record<string, unknown>;
}

export interface LegacyProfile {
  readonly contract?: number;
  readonly connections?: LegacyConnection[];
  readonly policy?: { allow?: unknown[]; deny?: unknown[] };
  readonly oauth_apps?: Record<string, unknown>;
  /**
   * Read for `token_ref` alone, and read raw rather than through `authSchema`:
   * this walks profiles that have not been validated, and a profile that fails
   * validation for an unrelated reason still has an endpoint token to leave
   * behind.
   */
  readonly auth?: { token_ref?: string };
}

/** The schema default, and what every profile written by the CLI carries. */
const DEFAULT_TOKEN_REF = 'profile/token';

/** Whether this workspace still holds anything at contract 2. */
export async function needsContract3(workspaceRoot: string): Promise<boolean> {
  for (const profile of await listProfiles(workspaceRoot)) {
    const raw = await readProfile(workspaceRoot, profile);
    if (raw !== null && (raw.contract ?? 0) === 2) return true;
  }
  return false;
}

async function readProfile(root: string, profile: string): Promise<LegacyProfile | null> {
  const text = await readWorkspaceFile(workspaceFiles(root), `profiles/${profile}.yaml`);
  if (text === null) return null;
  try {
    return parseDocument(text).toJSON() as LegacyProfile;
  } catch {
    // A file that will not parse is not this function's problem to report;
    // `check` gives it a better sentence than "needs migrating" would.
    return null;
  }
}

/** `gmail.main` — how a connection is addressed in every file after this. */
export function keyOf(connection: { provider: string; id: string }): string {
  return `${connection.provider}.${connection.id}`;
}

export async function migrateToContract3(
  workspaceRoot: string,
  options: { apply: boolean; subject?: string } = { apply: true },
): Promise<Contract3Migration> {
  const legacy = new Map<string, LegacyProfile>();

  for (const profile of await listProfiles(workspaceRoot)) {
    const raw = await readProfile(workspaceRoot, profile);
    if (raw !== null && (raw.contract ?? 0) === 2) legacy.set(profile, raw);
  }

  const nothing: Contract3Migration = {
    workspaceRoot,
    profiles: [],
    connections: [],
    renames: [],
    credentials: [],
    moved: [],
    changes: [],
    alreadyCurrent: true,
  };
  if (legacy.size === 0) return nothing;

  const { rows, renames, perProfile } = hoistConnections(legacy);
  const files = workspaceFiles(workspaceRoot);

  // Everything that can be computed is computed before the first write, so a
  // refusal leaves the workspace exactly as it was.
  const plans: CredentialPlan[] = [...legacy].map(([profile, config]) => ({
    profile,
    renames: refRenames(perProfile.get(profile) ?? new Map()),
    tokenRef:
      typeof config.auth?.token_ref === 'string' ? config.auth.token_ref : DEFAULT_TOKEN_REF,
  }));

  const credentials = await planCredentials(workspaceRoot, plans);
  const moves = await planMoves(files, [...legacy.keys()], perProfile);

  const changes: string[] = [
    `${CONNECTIONS_FILE}: ${rows.length} connection(s) hoisted`,
    ...renames.map((rename) => `renamed ${rename.from} to ${rename.to} (${rename.reason})`),
    ...[...legacy.keys()].map((profile) => `profiles/${profile}.yaml: contract 3, grants`),
  ];
  if (credentials.refs.length > 0) {
    changes.push(`${layout.credentials()}: ${credentials.refs.length} credential(s) merged`);
  }
  if (credentials.tokens.length > 0) {
    changes.push(
      `${credentials.tokens.join(', ')}: left behind — one endpoint token per workspace now, ` +
        'and a fresh one is minted on the next command',
    );
  }
  if (moves.length > 0) changes.push(`${moves.length} object(s) moved to their connection`);

  const result: Contract3Migration = {
    workspaceRoot,
    profiles: [...legacy.keys()],
    connections: rows.map(keyOf),
    renames,
    credentials: credentials.refs,
    moved: moves.map((move) => move.to),
    changes,
    alreadyCurrent: false,
  };

  if (!options.apply) return result;

  // The registry first, and this ordering is the whole of the re-entrancy.
  //
  // Every later step is idempotent — writing `connections.yaml` again produces
  // the same file, merging a credential that is already there is a no-op,
  // rewriting a contract-3 profile is skipped, and a move whose source is gone
  // is skipped. `rewriteRegistry` is the one step that is not, because it reads
  // `targets:` and would find none the second time.
  //
  // Running it last meant an interruption anywhere before it left profiles at
  // contract 3 and `lanes-link.yaml` still at contract 2 — a state where
  // re-entry found nothing to migrate, and `workspaceSchema` parsed a file whose
  // `workspaces:` defaulted to empty, so every command refused with "declares no
  // workspace" and there was no way back.
  await rewriteRegistry(workspaceRoot);
  await writeConnections(workspaceRoot, rows, legacy);
  await mergeCredentials(workspaceRoot, plans);

  // **The bytes move before the profile says they have.**
  //
  // `rewriteProfiles` is what stamps `contract: 3`, and that stamp is the only
  // thing `needsContract3` reads — so it is not a step among steps, it is the
  // record that the migration finished. Running it before `applyMoves` meant an
  // interruption between the two left profiles claiming contract 3 with every
  // byte still under `data/<profile>/`, and a re-run that looked at the stamp
  // and found nothing to do. The workspace opened, which is what this file
  // ordered its steps to guarantee, and the owner's memory, tasks, skills and
  // audit log were not in it.
  //
  // A network round trip per object made that window real rather than
  // theoretical: this migrates buckets now, and the first one it was pointed at
  // held 1,906 objects.
  await applyMoves(files, moves);
  await rewriteProfiles(workspaceRoot, legacy, perProfile, options.subject);

  return result;
}

/** The hoisted rows, plus every profile's `oauth_apps` merged into one block. */
async function writeConnections(
  root: string,
  rows: readonly LegacyConnection[],
  legacy: ReadonlyMap<string, LegacyProfile>,
): Promise<void> {
  const apps: Record<string, unknown> = {};
  for (const config of legacy.values()) Object.assign(apps, config.oauth_apps ?? {});

  const document = ConfigDocument.fromText(newConnectionsTemplate(), CONNECTIONS_FILE);
  document.setIn(['connections'], rows);
  document.setIn(['oauth_apps'], apps);

  await writeWorkspaceFile(workspaceFiles(root), CONNECTIONS_FILE, document.toString());
}

/** Contract 3, `grants:` and `members:`, with everything else left as written. */
async function rewriteProfiles(
  root: string,
  legacy: ReadonlyMap<string, LegacyProfile>,
  perProfile: ReadonlyMap<string, Map<string, string>>,
  subject: string | undefined,
): Promise<void> {
  for (const [profile, config] of legacy) {
    const document = await ConfigDocument.open(root, profile);

    document.setIn(['contract'], 3);
    document.setIn(['grants'], grantsFor(config, perProfile.get(profile) ?? new Map()));
    // Empty unless the migration was run by somebody signed in. Nobody is a
    // legitimate state and it is default deny on the identity axis, but a
    // workspace whose profiles nobody can consume is a poor thing to hand back,
    // so `update` passes the signed-in subject through.
    document.setIn(['members'], subject ? [{ subject, role: 'owner' }] : []);

    // The authorization block arrives here rather than in the template, because
    // an existing profile has one only if it was deployed. Every endpoint runs
    // the flow now, loopback included (ADR-062).
    if (document.getIn(['auth', 'authorization']) === undefined) {
      document.setIn(['auth', 'authorization'], { mode: 'self' });
    }

    document.removeIn(['connections']);
    document.removeIn(['policy']);
    document.removeIn(['oauth_apps']);

    await document.save();
  }
}

/** `targets:` becomes `workspaces:`, and a pointer's `workspace:` becomes `at:`. */
async function rewriteRegistry(root: string): Promise<void> {
  const document = await ConfigDocument.openKey(root, WORKSPACE_FILE);
  const registry = document.toJSON() as {
    contract?: number;
    targets?: Record<string, { workspace?: string }>;
  } | null;

  const targets = registry?.targets;

  // Already renamed, which is what a contract-1 workspace looks like here: the
  // 1-to-2 migration wrote `workspaces:` on its way through. Returning early
  // skipped the contract stamp and the default below, so that path finished a
  // migration and left neither.
  if (targets !== undefined) {
    const workspaces: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(targets)) {
      const { workspace, ...rest } = entry;
      workspaces[name] = workspace === undefined ? rest : { at: workspace, ...rest };
    }

    document.setIn(['workspaces'], workspaces);
    document.removeIn(['targets']);
  }

  document.setIn(['contract'], 3);
  const workspaces = (document.toJSON() as { workspaces?: Record<string, unknown> } | null)
    ?.workspaces ?? {};

  // The workspace on this machine, and only the *first* one when there is no
  // such thing. Written rather than left absent so the sticky default is on
  // from the first command after upgrading (ADR-061).
  //
  // This used to take the first key outright, on the stated grounds that "for
  // every workspace this migration will ever see" that is `local`. It is not:
  // the registry is written sorted, so a workspace that had ever deployed came
  // out of the 1-to-2 migration with `cloud` ahead of `local`. Upgrading then
  // pointed every subsequent command at a bucket — which is the one kind of
  // workspace that can be unreachable, and was: the next `status` answered with
  // a 403 from GCS rather than with the profiles sitting on the disk.
  //
  // A pointer carries `at:`; a workspace declaring its own adapters does not.
  if (document.getIn(['default_workspace']) === undefined) {
    const names = Object.keys(workspaces);
    const here = names.find(
      (name) => (workspaces[name] as { at?: unknown } | undefined)?.at === undefined,
    );
    const chosen = here ?? names[0];
    if (chosen !== undefined) document.setIn(['default_workspace'], chosen);
  }

  await document.save();
}
