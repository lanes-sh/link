import { describeBlobStoreContract, type ContractBlobStore } from './conformance.ts';
import { createMemoryBlobStore } from './testing.ts';

/**
 * The in-memory store, held to the same contract as the real adapters.
 *
 * It is what `apps/server/src/harness.ts` and every provider test run against,
 * so a behaviour it is more permissive about than the filesystem or S3 is a
 * behaviour those tests prove nothing about. Running the shared suite here is
 * what makes "tested against memory" mean "will work on a target".
 */

async function memoryStore(): Promise<ContractBlobStore> {
  const store = createMemoryBlobStore();
  return {
    // One store per contract case; nothing to reopen and nothing to clean up.
    open: () => store,
    async dispose() {},
  };
}

describeBlobStoreContract('memory', memoryStore);
