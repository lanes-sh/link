/**
 * The CLI's composition root — what a command gets handed before it runs.
 *
 * Three files, split along what each caller actually needs:
 *
 *   select.ts    which profile and target, and that target's secrets — the
 *                part that opens no database
 *   registry.ts  which providers exist, and keeping the skills among them
 *                current; synchronous, and needs no adapters
 *   open.ts      the whole runtime: database, storage, vault, dispatcher
 *
 * The seam is not cosmetic. `secrets push` holds two targets open at once and
 * `deploy` reads manifests against a bucket it cannot reach, so both stop at
 * `select.ts` and would fail on what `open.ts` does. This file stays a barrel
 * because `#cli/runtime.ts` is the spelling `#server` and `#deployments` bind,
 * and two test files import it directly.
 */

export {
  ensureProfileToken,
  openBlobStoreFor,
  openSecretStoreFor,
  ownerPrincipal,
  resolveProfile,
  resolveProfileOnly,
  type GlobalFlags,
} from './runtime/select.ts';

export {
  buildRegistry,
  buildRegistryWithWorkspace,
  type OwnerLayerOptions,
} from './runtime/registry.ts';

export { openRuntime, type OpenOptions, type Runtime } from './runtime/open.ts';
