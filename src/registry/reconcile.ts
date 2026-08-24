import type { SecretStore } from '#secrets';
import type { ConnectionRecord, ConnectionStatus, RuntimeState } from '#stores/state';
import {
  credentialRefForConnection,
  rotatableCredentialRefs,
  type ProviderManifest,
} from '#connectivity';
import type { ConnectionConfig, Config } from '#profile';

/**
 * Where a connection's credential lives.
 *
 * The single authority, because there used to be two that disagreed: reconcile
 * derived `<provider>/<id>` and never read the manifest, while the request
 * authorizer read the manifest and never derived. A provider declaring
 * `credential_ref: mything/api_key` was therefore reported unauthorized forever
 * — `doctor` told you to run `connect`, and `connect` did not help.
 *
 * The manifest answers it, and the connection's own `credential_ref` does not
 * overrule that. It used to, and the override was reported rather than obeyed:
 * `resolveSecretRefs` treats the field as an *addition* to what a connection may
 * reach, and every path that actually reads a credential — the OAuth refresh,
 * `connect`, `requirements`, `setup` — derives from the manifest and has never
 * read it. Substituting here made the status disagree with the request in both
 * directions: `active` on a connection whose every call 401s, and unauthorized
 * on one that works, which is the same bug this function was written to end
 * arriving from the other side.
 *
 * It is still the answer when the manifest gives none. A `local` provider
 * authenticates with nothing, so there is no derived ref to contradict, and
 * `resolveSecretRefs` makes this field that connection's whole allowlist —
 * which leaves reporting whether it is present the only signal there is.
 */
export function credentialRefFor(
  connection: ConnectionConfig,
  manifest: ProviderManifest | undefined,
): string | undefined {
  const derived = manifest ? credentialRefForConnection(manifest, connection.id) : undefined;
  return derived ?? connection.credential_ref;
}

/**
 * The same question for a deploy, which needs the refs a *running* instance
 * rewrites so it can grant them and nothing else.
 *
 * Deliberately not routed through `credentialRefFor`, and so deliberately blind
 * to a hand-placed `credential_ref`: the refresh path derives from the manifest
 * and has never read the config field, so the ref written is the derived one
 * whatever the connection says. Granting what the config names instead would
 * bind a secret nobody writes and leave the one that is written unbound.
 *
 * `#deployments` cannot import `#connectivity` — see `architecture.test.ts` —
 * which is why the crossing happens here, next to the sibling that already
 * makes it.
 */
export function rotatableCredentialRefsFor(
  connection: ConnectionConfig,
  manifest: ProviderManifest | undefined,
): readonly string[] {
  return manifest ? rotatableCredentialRefs(manifest, connection.id) : [];
}

/**
 * The OAuth client a revision signs its refreshes with, where the profile holds one.
 *
 * Read-only, and only for a profile that declares the entry: the client is the
 * operator's, shared by every connection of that vendor, and ADR-026's line is
 * that a revision rotates what is its own and never rewrites somebody else's.
 * So this is deliberately *not* part of `rotatableCredentialRefsFor`.
 *
 * These were missing, and the failure was silent in the worst way. The
 * gcp-secret-manager adapter answers `null` only on a 404 — an *unbound* secret
 * is a 403, which throws — so a bring-your-own Google connection on Cloud Run
 * would serve until its access token expired and then fail every call, an hour
 * after the revision reported healthy. A profile that authorises against a
 * broker declares no entry and so adds nothing here, which is the arrangement
 * this is meant to leave alone.
 *
 * Here rather than in `#deployments` for the reason its sibling gives: that
 * component cannot import `#connectivity`, and this needs the manifest.
 */
export function ownClientRefsFor(
  manifest: ProviderManifest | undefined,
  oauthApps: Readonly<Record<string, { client_id_ref: string; client_secret_ref: string }>>,
): readonly string[] {
  if (manifest?.auth.kind !== 'oauth' || manifest.auth.registration !== 'manual') return [];
  const app = manifest.auth.app;
  if (!app) return [];

  const declared = oauthApps[app];
  return declared ? [declared.client_id_ref, declared.client_secret_ref] : [];
}

/**
 * How to find a provider's manifest, so a missing `credential_ref` can derive.
 *
 * A lookup rather than a boolean: "does this authenticate" was never enough to
 * answer "where does the credential live", and pretending otherwise is what let
 * the two answers drift apart.
 */
export type AuthenticatingProviders = (providerId: string) => ProviderManifest | undefined;

/**
 * Reconcile declared config against runtime state.
 *
 * Planning and applying are separate functions over the same plan, so
 * `lanes link plan` and `lanes link start` cannot disagree about what is about to happen. If
 * the preview were computed differently from the mutation, the preview would
 * eventually become a lie.
 */

export type ReconcileAction =
  | { kind: 'create'; connection: string; displayName: string; status: ConnectionStatus }
  | { kind: 'update'; connection: string; changes: readonly string[] }
  | { kind: 'status'; connection: string; from: ConnectionStatus; to: ConnectionStatus; reason: string }
  /**
   * An undeclared connection is disabled, never deleted. Deleting it would
   * orphan its audit history, and the log's value is precisely that it outlives
   * the configuration that produced it.
   */
  | { kind: 'disable'; connection: string; reason: string }
  | { kind: 'unchanged'; connection: string };

export interface ReconcilePlan {
  readonly actions: readonly ReconcileAction[];
  /** Declared in config but absent from the state. */
  readonly missingInDatabase: readonly string[];
  /** Present in the state but no longer declared. */
  readonly undeclared: readonly string[];
  /** Declared connections whose credential could not be resolved. */
  readonly unauthorized: readonly string[];
}

export function planIsNoop(plan: ReconcilePlan): boolean {
  return plan.actions.every((action) => action.kind === 'unchanged');
}

/**
 * Work out what reconcile would do, without touching anything.
 *
 * A missing credential does NOT fail: the connection is marked `unauthorized`,
 * startup continues, and the problem surfaces in `lanes link doctor` and as an
 * actionable error if that connection's capability is actually called. A
 * half-configured Gmail account must not stop the other providers from serving.
 */
export async function planReconcile(
  config: Config,
  state: RuntimeState,
  credentials: SecretStore,
  /**
   * Optional so tests and callers without a registry keep working: without it,
   * only an explicit `credential_ref` is checked, which is the pre-derivation
   * behaviour.
   */
  manifestFor: AuthenticatingProviders = () => undefined,
): Promise<ReconcilePlan> {
  const existing = new Map<string, ConnectionRecord>();
  for (const record of await state.connections.list()) {
    existing.set(`${record.provider}.${record.id}`, record);
  }

  const actions: ReconcileAction[] = [];
  const missingInDatabase: string[] = [];
  const unauthorized: string[] = [];
  const declared = new Set<string>();

  for (const connection of config.connections) {
    const key = `${connection.provider}.${connection.id}`;
    declared.add(key);

    const ref = credentialRefFor(connection, manifestFor(connection.provider));
    const authorized = ref
      ? await credentials.has(ref)
      : true; // A provider needing no credential is authorized by construction.

    if (!authorized) unauthorized.push(key);

    // Declaring the connection is what enables it. There is no separate
    // `enabled` flag to disagree with the connection's own existence; to turn
    // one off, delete it or deny its capabilities.
    const desired: ConnectionStatus = authorized ? 'active' : 'unauthorized';

    const record = existing.get(key);
    if (!record) {
      missingInDatabase.push(key);
      actions.push({
        kind: 'create',
        connection: key,
        displayName: connection.account,
        status: desired,
      });
      continue;
    }

    const changes: string[] = [];
    if (record.displayName !== connection.account) changes.push('account');

    if (changes.length > 0) actions.push({ kind: 'update', connection: key, changes });

    if (record.status !== desired) {
      actions.push({
        kind: 'status',
        connection: key,
        from: record.status,
        to: desired,
        reason: authorized
          ? 'credential resolves'
          : `credential ${ref} is missing from the credential store`,
      });
    } else if (changes.length === 0) {
      actions.push({ kind: 'unchanged', connection: key });
    }
  }

  const undeclared: string[] = [];
  for (const [key, record] of existing) {
    if (declared.has(key)) continue;
    undeclared.push(key);
    if (record.status !== 'disabled') {
      actions.push({
        kind: 'disable',
        connection: key,
        reason: 'no longer declared in config; disabled rather than deleted to preserve audit history',
      });
    }
  }

  return { actions, missingInDatabase, undeclared, unauthorized };
}

export async function applyReconcile(
  config: Config,
  state: RuntimeState,
  plan: ReconcilePlan,
): Promise<void> {
  const byKey = new Map(config.connections.map((c) => [`${c.provider}.${c.id}`, c]));

  for (const action of plan.actions) {
    if (action.kind === 'unchanged') continue;

    const [provider = '', id = ''] = splitConnectionKey(action.connection);

    if (action.kind === 'disable') {
      await state.connections.setStatus(provider, id, 'disabled');
      continue;
    }

    if (action.kind === 'status') {
      await state.connections.setStatus(provider, id, action.to);
      continue;
    }

    const declared = byKey.get(action.connection);
    if (!declared) continue;

    await state.connections.upsert({
      provider,
      id,
      displayName: declared.account,
      status: action.kind === 'create' ? action.status : await currentStatus(state, provider, id),
    });
  }
}

async function currentStatus(
  state: RuntimeState,
  provider: string,
  id: string,
): Promise<ConnectionStatus> {
  return (await state.connections.get(provider, id))?.status ?? 'active';
}

function splitConnectionKey(key: string): [string, string] {
  const index = key.indexOf('.');
  return index === -1 ? [key, ''] : [key.slice(0, index), key.slice(index + 1)];
}

/**
 * Render a plan for `lanes link plan`.
 *
 * Reconcile disables undeclared connections, so this exists specifically so
 * that outcome is never a surprise.
 */
export function formatPlan(plan: ReconcilePlan): string {
  if (planIsNoop(plan)) return 'No changes. Runtime state matches the declared config.';

  const lines: string[] = [];
  for (const action of plan.actions) {
    switch (action.kind) {
      case 'create':
        lines.push(`  + ${action.connection}  create (${action.status})`);
        break;
      case 'update':
        lines.push(`  ~ ${action.connection}  update ${action.changes.join(', ')}`);
        break;
      case 'status':
        lines.push(`  ~ ${action.connection}  ${action.from} -> ${action.to}  (${action.reason})`);
        break;
      case 'disable':
        lines.push(`  - ${action.connection}  disable  (${action.reason})`);
        break;
      case 'unchanged':
        break;
    }
  }

  if (plan.unauthorized.length > 0) {
    lines.push('', 'Unauthorized connections (startup continues; these will error if called):');
    for (const key of plan.unauthorized) lines.push(`    ${key}  — run: lanes link connect ${key}`);
  }

  return lines.join('\n');
}
