import {
  memoryForget,
  memoryGet,
  memoryList,
  memoryWrite,
  skillsAdd,
  skillsList,
  skillsRemove,
  skillsShow,
  vaultGet,
  vaultKeyGenerate,
  vaultList,
  vaultRemove,
  vaultSet,
  type OwnerFlags,
} from './commands/owner.ts';

/**
 * The three commands over the owner's own data: memory, skills, and the vault.
 *
 * Split out of `main.ts` for the reason the budget in `src/architecture.test.ts`
 * exists to find, rather than to satisfy a line count. These three are one
 * subject — what the owner put here themselves, as against what a provider
 * holds on their behalf — they already live together in `commands/owner/`, and
 * they are the only commands in the grammar sharing a flag shape of their own.
 *
 * `main.ts` keeps the grammar. This keeps one branch of it.
 */
export function dispatchOwner(
  first: string,
  second: string | undefined,
  rest: readonly string[],
  owner: OwnerFlags,
  program: string,
): Promise<void> | void {
  switch (first) {
    case 'memory':
      switch (second) {
        case 'list':
        case undefined:
          return memoryList(owner);
        case 'get':
          return memoryGet(rest[0], owner);
        case 'write':
          return memoryWrite(rest[0], owner);
        case 'forget':
          return memoryForget(rest[0], owner);
        default:
          throw new Error(`Unknown: ${program} memory ${second}`);
      }

    case 'skills':
      switch (second) {
        case 'list':
        case undefined:
          return skillsList(owner);
        case 'show':
          return skillsShow(rest[0], owner);
        case 'add':
          return skillsAdd(rest[0], owner);
        case 'remove':
          return skillsRemove(rest[0], owner);
        default:
          throw new Error(`Unknown: ${program} skills ${second}`);
      }

    case 'vault':
      switch (second) {
        case 'list':
        case undefined:
          return vaultList(owner);
        case 'get':
          return vaultGet(rest[0], owner);
        case 'set':
          return vaultSet(rest[0], owner);
        case 'remove':
          return vaultRemove(rest[0], owner);
        case 'key':
          if (rest[0] !== 'generate') {
            throw new Error(`Usage: ${program} vault key generate`);
          }
          return vaultKeyGenerate(owner);
        default:
          throw new Error(`Unknown: ${program} vault ${second}`);
      }

    default:
      // Unreachable: `main.ts` narrows to the three above before calling. Kept
      // so that adding a fourth case there and forgetting it here is a thrown
      // error rather than a command that silently does nothing.
      throw new Error(`Unknown: ${program} ${first}`);
  }
}
