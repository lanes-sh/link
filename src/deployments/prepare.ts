import { credentialRefFor, ownClientRefsFor, rotatableCredentialRefsFor } from '#registry';
import {
  readConnections, listProfiles, loadProfileConfig, vaultRef, type Config, type TargetConfig } from '#profile';
import { VAULT_DOCUMENT_REF, VAULT_KEY_REF, generateVaultKey, type SecretStore } from '#secrets';
import { ok, print, style, warn } from '#cli/output.ts';
import { buildRegistryWithWorkspace, ensureProfileToken } from '#cli/runtime.ts';

/**
 * Getting the target's credential store to the state a revision can boot from.
 *
 * This began as a refusal — list what is missing, name the command that stores
 * each one, exit. That is a correct refusal and three round trips: the operator
 * runs `deploy`, reads the list, runs `token rotate`, runs `secrets set`, runs
 * `deploy` again. Two of those values the command can produce or ask for right
 * here, and the third is genuinely somebody else's to create.
 *
 * What blocks versus what warns follows what the runtime does with each: without
 * the profile token the endpoint refuses to start, and without the database URL
 * it cannot open a database at all. A connection credential that is missing
 * leaves that connection `unauthorized`, which is a documented state rather than
 * an outage — so it is said out loud and not treated as a failure.
 */

export interface PrepareInput {
  readonly config: Config;
  /** The target's adapter set, from the workspace that declares it (ADR-052). */
  readonly declared: TargetConfig;
  readonly credentials: SecretStore;
  readonly root: string;
  readonly target: string;
  /** Never prompt; report only. `--dry-run` must not write to a credential store. */
  readonly readOnly: boolean;
}

export interface PrepareResult {
  /** Refs still missing after any seeding, which a revision cannot start without. */
  readonly blocking: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Every credential reference a *running* revision rewrites — what `provision`
 * needs in order to grant `secretVersionAdder` on each one and nothing else.
 *
 * Kept apart from the connection loop below rather than derived from it, because
 * the two answer different questions and diverge on purpose: that loop asks
 * where a connection's credential lives, which a hand-placed `credential_ref`
 * may decide, and this asks what gets written while serving, which the refresh
 * path derives from the manifest and has never read config for. Sharing one list
 * would silently pick one answer for both.
 *
 * **Scoped exactly as the upload is**, for the reason `repairOwnerLayer`
 * states and one more: a profile this deploy sends is a profile the endpoint may
 * serve, and a connection whose secret nobody bound fails an hour after the
 * revision reports healthy. The asymmetry decides it — an extra binding is a
 * resource-level grant on a secret the operator already owns, and a missing one
 * is a 403 in somebody's chat window.
 *
 * A profile that cannot be read is skipped rather than fatal, matching the
 * repair: `deploy` validates the profile it resolved, and a broken sibling
 * should not cost the rollout. It goes up either way, and if it is served at
 * all it is served broken for reasons that have nothing to do with IAM.
 *
 * Called before `provision`, which is before any store is opened — so it reads
 * config and manifests only, and touches no credential.
 */
export async function rotatableRefs(
  root: string,
  profiles: readonly string[] | undefined,
  declared: TargetConfig | undefined,
): Promise<string[]> {
  const refs = new Set<string>();
  const wanted = profiles === undefined ? undefined : new Set(profiles);

  for (const name of await listProfiles(root)) {
    if (wanted !== undefined && !wanted.has(name)) continue;

    let config: Config;
    try {
      ({ config } = await loadProfileConfig(root, name));
    } catch {
      continue;
    }

    // `vault.put` is a capability an agent may hold under policy (ADR-022), so
    // the revision rewrites this one — and it is per vault connection, which is
    // what makes this a per-profile pass rather than a target-level constant.
    // The loop had been reduced to `void config` when the derivation moved out;
    // this is it moving back, next to the config it needs.
    if (declared?.vault?.adapter === 'secret') refs.add(vaultRef(declared, config));
  }

  // Once, outside the profile loop. Connections and the manifests that describe
  // them belong to the workspace (ADR-057), so the per-profile registry ADR-030
  // required is gone — and with it the failure it guarded against, where a
  // connection in `work` resolved to nothing against `personal`'s registry and
  // the missed ref became a 403 an hour after the revision reported healthy.
  //
  // Every connection, not just granted ones: a credential a revision cannot read
  // is a broken account, and whether some profile currently grants it is a
  // question that changes without redeploying.
  const registry = await buildRegistryWithWorkspace(root);
  for (const connection of (await readConnections(root)).connections) {
    const manifest = registry.manifest(connection.provider);
    for (const ref of rotatableCredentialRefsFor(connection, manifest)) refs.add(ref);
  }

  // Sorted, and a set: two Gmail connections share one dynamically registered
  // client ref, and two profiles may name the same connection. A step list that
  // repeated one would read as two different grants.
  return [...refs].sort();
}

/**
 * Every credential reference a running revision *reads*, so provision can bind
 * `secretAccessor` on each one instead of on the whole project.
 *
 * The project-level grant this replaces was not an oversight — the adapter
 * argued for it, on the grounds that the line worth defending is
 * `secrets.create` — but it is broader than the revision ever needs, and the
 * survey happily points a deploy at a project the operator already uses for
 * other things. An SSRF or an RCE in the endpoint should reach this profile's
 * own credentials, not every secret sharing a project with it.
 *
 * Feasible because the serving path only ever reads by explicit ref: `list()`
 * is a CLI call, and `secretAccessor` never granted `secrets.list` anyway. So
 * the set is knowable at deploy time, and it is the same walk `rotatableRefs`
 * does — profiles, their connections, and the manifests behind them.
 *
 * Deliberately a superset, matching the asymmetry `rotatableRefs` states: an
 * extra resource-level binding on a secret the operator already owns costs
 * nothing, and a missing one is a 403 an hour after the revision reports
 * healthy. Both `credentialRefFor` and `rotatableCredentialRefsFor` go in
 * because the first honours a hand-placed `credential_ref` and the second is
 * blind to it by design — the revision may read either.
 *
 * The same deploy-time bound the write side already lives with applies here: a
 * connection authorised after a rollout is unreadable until the next one. That
 * is not new, and `provision` is re-run by every deploy.
 */
export async function readableRefs(
  root: string,
  profiles: readonly string[] | undefined,
  declared: TargetConfig | undefined,
): Promise<string[]> {
  const refs = new Set<string>();

  // Only the key is the target's. The *document* is named per vault connection
  // (ADR-059), so it is added inside the profile loop below — naming it here
  // meant `vault/document`, which is not what `openVault` opens, and the
  // revision 403'd on a ref nothing had created. See `vaultRef`.
  if (declared?.vault?.adapter === 'secret') {
    refs.add(VAULT_KEY_REF);
  } else if (declared?.vault?.adapter === 'blob') {
    // Ciphertext lives in the bucket, but the key that opens it is still here.
    refs.add(VAULT_KEY_REF);
  }

  const wanted = profiles === undefined ? undefined : new Set(profiles);

  for (const name of await listProfiles(root)) {
    if (wanted !== undefined && !wanted.has(name)) continue;

    let config: Config;
    try {
      ({ config } = await loadProfileConfig(root, name));
    } catch {
      continue;
    }

    refs.add(config.auth.token_ref);
    if (declared?.vault?.adapter === 'secret') refs.add(vaultRef(declared, config));
    // The OIDC audience check reads this on every verify (`server/endpoint.ts`).
    if (config.auth.authorization?.mode === 'oidc') {
      refs.add(config.auth.authorization.client_id_ref);
    }

  }

  // Once, for the reason `rotatableRefs` gives.
  const connectionsFile = await readConnections(root);
  const registry = await buildRegistryWithWorkspace(root);

  for (const connection of connectionsFile.connections) {
    const manifest = registry.manifest(connection.provider);
    const ref = credentialRefFor(connection, manifest);
    if (ref) refs.add(ref);
    for (const rotatable of rotatableCredentialRefsFor(connection, manifest)) refs.add(rotatable);
    for (const client of ownClientRefsFor(manifest, connectionsFile.oauth_apps)) refs.add(client);
  }

  return [...refs].sort();
}

export async function prepareSecrets(input: PrepareInput): Promise<PrepareResult> {
  const { config, credentials, root, target, readOnly } = input;
  const blocking: string[] = [];
  const warnings: string[] = [];

  await seedProfileToken({ config, credentials, readOnly, blocking });
  await seedVaultKey({ declared: input.declared, credentials, readOnly });

  // Connection credentials are written by `connect`, against a real account, in
  // a browser. Nothing here can produce one, and a deploy that stopped for one
  // would be refusing to roll a revision over a mailbox that has not been
  // authorised yet — which is a thing you might reasonably want to do.
  //
  // The command is spelled out rather than described. This is the one manual
  // step a deploy genuinely cannot take for you, so it should cost a paste
  // rather than a trip to the docs to work out how the id is spelled.
  const registry = await buildRegistryWithWorkspace(root);
  for (const connection of (await readConnections(root)).connections) {
    const ref = credentialRefFor(connection, registry.manifest(connection.provider));
    if (!ref || (await credentials.has(ref))) continue;
    warnings.push(
      `${connection.provider}.${connection.id} is not authorised yet — no credential at "${ref}"\n` +
        `    lanes link connect ${connection.provider} --profile ${input.config.instance.profile} --workspace ${target} --id ${connection.id}`,
    );
  }

  return { blocking, warnings };
}

/**
 * The key that seals the vault document.
 *
 * Minted here for the same reason the profile token is: it is a random string
 * this process generates correctly and nobody can usefully choose. It used to be
 * three manual commands in `https://lanes.sh/docs/link/deployment-cloudrun` — generate, store,
 * mount — whose only failure mode was forgetting them and finding out when the
 * first `vault.*` call failed against a revision that had booted healthy.
 *
 * Only for a target whose credential store can hold it. A `file` vault is a
 * local run, where the environment variable is the operator's own business.
 *
 * Never regenerated. A second key does not fail — it decrypts nothing, and the
 * document it cannot open is the one holding every password the owner put
 * there.
 */
async function seedVaultKey(input: {
  declared: TargetConfig | undefined;
  credentials: SecretStore;
  readOnly: boolean;
}): Promise<void> {
  const adapter = input.declared?.vault?.adapter;
  if (adapter !== 'secret' && adapter !== 'blob') return;
  if (input.readOnly || (await input.credentials.has(VAULT_KEY_REF))) return;

  await input.credentials.set(VAULT_KEY_REF, generateVaultKey());
  print(ok(`minted the vault key at "${VAULT_KEY_REF}" — the revision reads it from there`));
}

/**
 * The endpoint's own bearer token.
 *
 * Minted rather than demanded, and not even asked about: it is a random string
 * this process generates correctly and the operator cannot usefully choose, so a
 * prompt would be a question with one answer. `ensureProfileToken` is the same
 * call `outputs` makes for a local target, which is what keeps "the token" one
 * thing rather than a per-command notion.
 *
 * The deployed container deliberately will *not* do this — a token invented
 * inside something that scales to zero is a token nobody can read back, and the
 * endpoint would come up healthy while rejecting every agent.
 */
async function seedProfileToken(input: {
  config: Config;
  credentials: SecretStore;
  readOnly: boolean;
  blocking: string[];
}): Promise<void> {
  const ref = input.config.auth.token_ref;
  if (await input.credentials.has(ref)) return;

  if (input.readOnly) {
    input.blocking.push(`the endpoint bearer token — nothing at "${ref}"`);
    return;
  }

  const { created } = await ensureProfileToken(input.credentials, ref);
  if (created) print(ok(`minted an endpoint token at "${ref}" — read it with lanes link token show`));
}

