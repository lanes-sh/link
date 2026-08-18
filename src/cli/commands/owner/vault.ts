import { ConfigError } from '#profile';
import { assertItemId, generateVaultKey } from '#providers/owner.ts';
import { heading, ok, print, style, table } from '../../output.ts';
import {
  agreed,
  ownerConnection,
  readStdin,
  required,
  withRuntime,
  type OwnerFlags,
} from './shared.ts';

/**
 * `lanes link vault` — the owner's own secret material.
 *
 * `lanes link vault get` prints a value, which `lanes link secrets` deliberately never does.
 * That is the two-kinds-of-secret distinction doing its job
 * (`docs/detailed/security.md`): a credential authorises the system and is never
 * disclosed, and a vault the owner cannot read without an agent is not a vault.
 */

export async function vaultList(flags: OwnerFlags): Promise<void> {
  await withRuntime(flags, async (runtime) => {
    const items = await runtime.vault.ids();

    heading(`Vault items (${items.length})`);
    if (items.length === 0) {
      print(style.dim('  none — store one with: lanes link vault set <id>'));
      return;
    }

    table(
      items.map((item) => [
        `  ${item.id}`,
        style.dim(item.connectionId),
        item.description ?? '',
      ]),
    );

    print('');
    print(
      style.dim(
        '  Names only. Each is readable over MCP as "vault.get.<id>", one grant at a time.',
      ),
    );
  });
}

export async function vaultGet(id: string | undefined, flags: OwnerFlags): Promise<void> {
  const itemId = required(id, 'lanes link vault get <id> [--show]');

  await withRuntime(flags, async (runtime) => {
    const connection = ownerConnection(runtime.config, 'vault', flags);
    const item = await runtime.vault.get(connection, itemId);
    if (!item) throw new ConfigError(`No vault item "${itemId}" in this profile.`);

    // `--raw` writes the value and nothing else, so `$(…)` is not contaminated
    // by the announce line every other command prints. Same shape as
    // `lanes link token show --raw`.
    if (flags.raw) {
      process.stdout.write(`${item.value}\n`);
      return;
    }

    print(
      flags.show
        ? item.value
        : `${item.value.slice(0, 3)}…  ${style.dim(`(${item.value.length} chars — --show to reveal)`)}`,
    );
  });
}

export async function vaultSet(id: string | undefined, flags: OwnerFlags): Promise<void> {
  const itemId = required(id, 'lanes link vault set <id>   (value on stdin)');
  assertItemId(itemId);

  const value = await readStdin(`lanes link vault set ${itemId}`, 'the secret');

  await withRuntime(flags, async (runtime) => {
    const connection = ownerConnection(runtime.config, 'vault', flags);
    const replacing = (await runtime.vault.get(connection, itemId)) !== null;

    await runtime.vault.put(connection, {
      id: itemId,
      value,
      ...(flags.description ? { description: flags.description } : {}),
    });

    print(ok(`${replacing ? 'replaced' : 'stored'} vault item ${style.bold(itemId)}`));
    if (!replacing) {
      // Not a limitation being apologised for: the item list is read when the
      // runtime is built, so a write cannot hand itself a read and granting a
      // new secret is a deliberate act between two runs (ADR-012 §3).
      print(
        style.dim(
          `  Not readable over MCP yet. Allow "vault.get.${itemId}" in policy, then restart the endpoint.`,
        ),
      );
    }
  });
}

export async function vaultRemove(id: string | undefined, flags: OwnerFlags): Promise<void> {
  const itemId = required(id, 'lanes link vault remove <id>');

  await withRuntime(flags, async (runtime) => {
    const connection = ownerConnection(runtime.config, 'vault', flags);
    const item = await runtime.vault.get(connection, itemId);
    if (!item) throw new ConfigError(`No vault item "${itemId}" in this profile.`);

    print(`  ${style.bold(itemId)}  ${item.description ?? style.dim('no description')}`);
    if (!(await agreed(flags, 'Remove this item? The value cannot be recovered.'))) return;

    await runtime.vault.delete(connection, itemId);
    print(ok(`removed vault item ${style.bold(itemId)}`));
    print(style.dim('  Its read capability disappears when the endpoint restarts.'));
  });
}

/**
 * Mint a vault key.
 *
 * Deliberately not written anywhere: a deployment's key belongs in that
 * deployment's secret manager, and a command that helpfully stored it beside
 * the ciphertext it protects would encrypt nothing.
 */
export function vaultKeyGenerate(flags: OwnerFlags): void {
  const key = generateVaultKey();

  if (flags.raw) {
    process.stdout.write(`${key}\n`);
    return;
  }

  print(key);
  print('');
  print(style.dim('  Store it as LANES_LINK_VAULT_KEY. It is not written anywhere by this command:'));
  print(style.dim('  a key kept beside the document it protects protects nothing.'));
  print(style.dim('  Separate from the credential-store key, deliberately — docs/detailed/security.md.'));
}
