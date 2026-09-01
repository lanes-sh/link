import type { SecretStore } from '#secrets';
import type { Config, ConnectionConfig } from '#profile';
import type { ProviderManifest } from '#connectivity';

/**
 * Which connections belong to the same vendor account, and moving a credential
 * when a provisional id turns out to be the wrong one.
 *
 * All of it is about one problem: a vendor is not a provider. iCloud is three
 * providers on one Apple Account, so "the connections like this one" cannot be
 * answered by comparing provider ids.
 */

/** The credential group a provider belongs to, when it shares one with siblings. */
export function credentialApp(manifest: ProviderManifest): string | undefined {
  const auth = manifest.auth;
  return auth.kind === 'bearer' ||
    auth.kind === 'api_key' ||
    auth.kind === 'header' ||
    auth.kind === 'basic'
    ? auth.app
    : undefined;
}

/**
 * Connections belonging to the same vendor account as this provider would.
 *
 * `icloud_calendar` is a different provider from `icloud_mail` but the same
 * Apple Account, so its connection id has to match — that is what makes both
 * derive `icloud/<id>` and share the one app-specific password. Filtering on
 * provider id alone would miss it and ask for the password three times.
 */
export function accountSiblings(
  manifest: ProviderManifest,
  connections: readonly ConnectionConfig[],
  registry: { manifest(id: string): ProviderManifest | undefined },
): ConnectionConfig[] {
  const app = credentialApp(manifest);

  return connections.filter((connection) => {
    if (connection.provider === manifest.id) return true;
    if (!app) return false;
    const sibling = registry.manifest(connection.provider);
    return sibling ? credentialApp(sibling) === app : false;
  });
}

/**
 * The one account a sibling provider already holds, if there is exactly one.
 *
 * Adopting its id is what turns the second and third `connect` of a family into
 * "already stored" rather than a third identical password prompt. With two
 * accounts in play there is nothing to infer, so it declines rather than
 * guessing — the operator is asked, or names one with `--id`.
 */
export function siblingAccountId(
  manifest: ProviderManifest,
  connections: readonly ConnectionConfig[],
  registry: { manifest(id: string): ProviderManifest | undefined },
): string | undefined {
  if (!credentialApp(manifest)) return undefined;

  // Asked of the registry, not inferred from the id: `app` is a manifest field,
  // and a provider is free to declare `app: icloud` under any name it likes.
  const ids = new Set(
    accountSiblings(manifest, connections, registry)
      .filter((connection) => connection.provider !== manifest.id)
      .map((connection) => connection.id),
  );

  return ids.size === 1 ? [...ids][0] : undefined;
}

/** Whether an existing allow rule already covers the one we were about to add. */
export function matchesRule(existing: string, wanted: string): boolean {
  return existing === '*' || existing === wanted;
}

/**
 * Move a credential when a provisional id turns out to be the wrong one.
 *
 * Copy before delete: a crash between the two leaves the credential readable
 * under the old name, where `doctor` will flag it, rather than gone.
 */
export async function moveCredential(
  credentials: SecretStore,
  from: string,
  to: string,
): Promise<void> {
  const value = await credentials.get(from);
  if (value === null) return;
  await credentials.set(to, value);
  await credentials.delete(from);
}

/** What a spec that named an account rather than a provider turned out to mean. */
export function familyNote(providerId: string, family: readonly string[]): string {
  return `${providerId} is ${family.length} services on one account: ${family.join(', ')}`;
}
