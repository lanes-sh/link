import { newConnectionsTemplate } from './config-templates.ts';
import { applyMoves, mergeCredentials, planCredentials, planMoves, type Move } from './contract3-data.ts';
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
import { ConfigDocument } from './config-edit.ts';

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

interface LegacyConnection {
  readonly id: string;
  readonly provider: string;
  readonly account: string;
  readonly label?: string;
  readonly credential_ref?: string;
  readonly config?: Record<string, unknown>;
}

interface LegacyProfile {
  readonly contract?: number;
  readonly connections?: LegacyConnection[];
  readonly policy?: { allow?: unknown[]; deny?: unknown[] };
  readonly oauth_apps?: Record<string, unknown>;
}

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
function keyOf(connection: { provider: string; id: string }): string {
  return `${connection.provider}.${connection.id}`;
}

/**
 * Hoist every profile's connections into one list.
 *
 * **Keyed on provider and account, not on the id.** The common case is two
 * profiles that both connected the same mailbox: same provider, same account,
 * usually the same id, and they merge into one row because they *are* one
 * account. The interesting case is two profiles each holding a row spelled
 * `gmail.main` naming different mailboxes, which is legal under contract 2
 * because a connection lived inside one profile and nothing ever compared them.
 *
 * That collision is resolved by renaming, never by picking. Both accounts are
 * real, both have a credential, and choosing either would take somebody's
 * mailbox away silently. The second becomes `gmail.main_2`, and the rename is
 * reported so the operator sees it before anything else reads the file.
 */
function hoistConnections(profiles: ReadonlyMap<string, LegacyProfile>): {
  rows: LegacyConnection[];
  renames: ContractRename[];
  perProfile: Map<string, Map<string, string>>;
} {
  const rows: LegacyConnection[] = [];
  const renames: ContractRename[] = [];
  const byAccount = new Map<string, LegacyConnection>();
  const taken = new Set<string>();
  const perProfile = new Map<string, Map<string, string>>();

  for (const [profile, config] of profiles) {
    const mapping = new Map<string, string>();
    perProfile.set(profile, mapping);

    for (const connection of config.connections ?? []) {
      const identity = `${connection.provider} ${connection.account}`;
      const existing = byAccount.get(identity);

      if (existing) {
        // The same account, already hoisted. This profile's old key maps to
        // whatever the first one settled on, which may itself be a rename.
        mapping.set(keyOf(connection), keyOf(existing));
        continue;
      }

      let id = connection.id;
      if (taken.has(`${connection.provider}.${id}`)) {
        let suffix = 2;
        while (taken.has(`${connection.provider}.${id}_${suffix}`)) suffix += 1;
        const renamed = `${id}_${suffix}`;
        renames.push({
          from: `${connection.provider}.${id}`,
          to: `${connection.provider}.${renamed}`,
          reason: `"${profile}" named a different account (${connection.account}) with that id`,
        });
        id = renamed;
      }

      const row: LegacyConnection = { ...connection, id };
      rows.push(row);
      byAccount.set(identity, row);
      taken.add(keyOf(row));
      mapping.set(keyOf(connection), keyOf(row));
    }
  }

  return { rows, renames, perProfile };
}

/** A capability pattern, whichever of the two shapes the rule was written in. */
function patternsOf(rules: unknown): string[] {
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((rule) => {
    if (typeof rule === 'string') return [rule];
    const capability = (rule as { capability?: unknown } | null)?.capability;
    return typeof capability === 'string' ? [capability] : [];
  });
}

/**
 * The grant rows one contract-2 profile becomes.
 *
 * Every connection gets the rules that named its provider, which is precisely
 * what the flat block meant: rules covered every account of a provider in the
 * profile. So this loses nothing, and gains the ability to diverge afterwards.
 *
 * A rule naming a provider the profile has no connection for is dropped rather
 * than carried. Under contract 2 an `allow` like that was refused at load, and a
 * `deny` was permitted as a note to self; there is nowhere to put either now,
 * because a row without a connection is not expressible.
 */
function grantsFor(
  config: LegacyProfile,
  mapping: ReadonlyMap<string, string>,
): { connection: string; allow: string[]; deny: string[] }[] {
  const allow = patternsOf(config.policy?.allow);
  const deny = patternsOf(config.policy?.deny);

  const covers = (pattern: string, provider: string): boolean =>
    pattern === '*' || pattern.startsWith(`${provider}.`);

  return (config.connections ?? []).map((connection) => {
    const provider = connection.provider;
    // A bare `*` becomes the provider wildcard rather than being copied
    // through. It would still mean the same thing inside a row, which is
    // already scoped to one connection, but writing it out is what makes the
    // file say so.
    const widen = (pattern: string): string => (pattern === '*' ? `${provider}.*` : pattern);

    return {
      connection: mapping.get(keyOf(connection)) ?? keyOf(connection),
      allow: allow.filter((pattern) => covers(pattern, provider)).map(widen),
      deny: deny.filter((pattern) => covers(pattern, provider)).map(widen),
    };
  });
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
  const credentials = await planCredentials(workspaceRoot, [...legacy.keys()]);
  const moves = await planMoves(files, [...legacy.keys()], rows);

  const changes: string[] = [
    `${CONNECTIONS_FILE}: ${rows.length} connection(s) hoisted`,
    ...renames.map((rename) => `renamed ${rename.from} to ${rename.to} (${rename.reason})`),
    ...[...legacy.keys()].map((profile) => `profiles/${profile}.yaml: contract 3, grants`),
  ];
  if (credentials.length > 0) {
    changes.push(`${layout.credentials()}: ${credentials.length} credential(s) merged`);
  }
  if (moves.length > 0) changes.push(`${moves.length} object(s) moved to their connection`);

  const result: Contract3Migration = {
    workspaceRoot,
    profiles: [...legacy.keys()],
    connections: rows.map(keyOf),
    renames,
    credentials,
    moved: moves.map((move) => move.to),
    changes,
    alreadyCurrent: false,
  };

  if (!options.apply) return result;

  await writeConnections(workspaceRoot, rows, legacy);
  await mergeCredentials(workspaceRoot, [...legacy.keys()]);
  await rewriteProfiles(workspaceRoot, legacy, perProfile, options.subject);
  await applyMoves(files, moves);
  await rewriteRegistry(workspaceRoot);

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
  if (targets === undefined) return;

  const workspaces: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(targets)) {
    const { workspace, ...rest } = entry;
    workspaces[name] = workspace === undefined ? rest : { at: workspace, ...rest };
  }

  document.setIn(['contract'], 3);
  document.setIn(['workspaces'], workspaces);
  document.removeIn(['targets']);

  // The first workspace in the registry, which for every workspace this
  // migration will ever see is `local`. Written rather than left absent so the
  // sticky default is on from the first command after upgrading (ADR-061).
  if (document.getIn(['default_workspace']) === undefined) {
    const first = Object.keys(workspaces)[0];
    if (first !== undefined) document.setIn(['default_workspace'], first);
  }

  await document.save();
}
