import {
  assetsAdd,
  assetsGet,
  assetsList,
  assetsRemove,
  entitiesFind,
  entitiesForget,
  entitiesGet,
  entitiesLink,
  entitiesReindex,
  entitiesWrite,
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
  tasksAdd,
  tasksGet,
  tasksList,
  tasksRemove,
  tasksUpdate,
  vaultSet,
  type OwnerFlags,
} from './commands/owner.ts';

/**
 * The commands over the owner's own data: memory, tasks, assets, skills, vault,
 * entities.
 *
 * Split out of `main.ts` for the reason the budget in `src/architecture.test.ts`
 * exists to find, rather than to satisfy a line count. These are one subject —
 * what the owner put here themselves, as against what a provider holds on their
 * behalf — they already live together in `commands/owner/`, and they are the
 * only commands in the grammar sharing a flag shape of their own.
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

    case 'tasks':
      switch (second) {
        case 'list':
        case undefined:
          return tasksList(owner);
        case 'get':
          return tasksGet(rest[0], owner);
        case 'add':
          return tasksAdd(rest[0], owner);
        case 'update':
          return tasksUpdate(rest[0], owner);
        case 'remove':
          return tasksRemove(rest[0], owner);
        default:
          throw new Error(`Unknown: ${program} tasks ${second}`);
      }

    case 'assets':
      switch (second) {
        case 'list':
        case undefined:
          return assetsList(owner);
        case 'get':
          return assetsGet(rest[0], owner);
        case 'add':
          return assetsAdd(rest[0], owner);
        case 'remove':
          return assetsRemove(rest[0], owner);
        default:
          throw new Error(`Unknown: ${program} assets ${second}`);
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

    case 'entities':
      switch (second) {
        // Bare `entities` is a listing, which is `find` with no criteria — one
        // name for one concept rather than a `list` that would be the same code
        // under a second word.
        case 'find':
        case undefined:
          return entitiesFind(rest[0], owner);
        case 'get':
          return entitiesGet(rest[0], owner);
        case 'write':
          return entitiesWrite(rest[0], owner);
        case 'link':
          return entitiesLink(rest[0], rest[1], owner);
        case 'forget':
          return entitiesForget(rest[0], owner);
        case 'reindex':
          return entitiesReindex(owner);
        default:
          throw new Error(`Unknown: ${program} entities ${second}`);
      }

    default:
      // Unreachable: `main.ts` narrows to the nouns above before calling. Kept
      // so that adding one there and forgetting it here is a thrown error rather
      // than a command that silently does nothing.
      throw new Error(`Unknown: ${program} ${first}`);
  }
}
