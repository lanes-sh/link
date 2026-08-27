/**
 * `lanes link memory`, `tasks`, `assets`, `skills`, `vault` — the owner layer's
 * control plane.
 *
 * The layer shipped in M4 with no CLI at all, so the two stores holding the
 * owner's *own* data were reachable only by an agent, and the one thing that
 * shapes agent behaviour was reachable only by editing a file and restarting.
 * Putting a password into the vault meant asking a language model to type it.
 * ADR-014.
 *
 * **These commands reach the same bytes the providers do**, through the same
 * stores — `runtime.skills`, `runtime.vault`, and the blob namespace core
 * scopes memory to. Nothing here reimplements a storage layout, because two
 * spellings of one layout is exactly how a control plane and its data plane
 * drift apart.
 *
 * This does not widen ADR-007. Its exclusion list is policy, tokens,
 * credentials, connections, config, and audit — the things that authorise
 * *future agent behaviour*. A memory entry and a vault item are the owner's own
 * data. Skills are the interesting case and are deliberately reachable from
 * both sides now: from here because this is the owner's control plane, and over
 * MCP because ADR-014 §1 decided a policy-gated grant beats a missing path.
 *
 * One noun per file — `memory.ts`, `tasks.ts`, `assets.ts`, `skills.ts`,
 * `vault.ts` — over the shape they all share in `shared.ts`: the flag type, the
 * open-announce-act-close wrapper, connection resolution, and the two prompts.
 */

export {
  memoryForget,
  memoryGet,
  memoryList,
  memoryStore,
  memoryWrite,
} from './owner/memory.ts';

export { tasksAdd, tasksGet, tasksList, tasksRemove, tasksUpdate } from './owner/tasks.ts';

export { assetsAdd, assetsGet, assetsList, assetsRemove } from './owner/assets.ts';

export { skillsAdd, skillsList, skillsRemove, skillsShow } from './owner/skills.ts';

export {
  vaultGet,
  vaultKeyGenerate,
  vaultList,
  vaultRemove,
  vaultSet,
} from './owner/vault.ts';

export { ownerConnection, type OwnerFlags } from './owner/shared.ts';
