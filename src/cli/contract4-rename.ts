import { nextConnectionId } from './identity.ts';
import { C3_OWNER_PROVIDERS } from './contract3-layout.ts';
import type { Renames } from './contract4-data.ts';

/**
 * What every connection is called after contract 4.
 *
 * Its own module because it is one decision read by four rewrites — the rows,
 * the grants, the blob paths and the state keys — and because a map keyed one
 * way and queried another is the bug `contract3-data.ts` records shipping once.
 * One place to build it, one place for everything else to read it from.
 */

/**
 * The id and provider every connection ends up with.
 *
 * Two things happen here, and the merge is the interesting one.
 *
 * **The owner layer merges to one row per surface.** Contract 3 made the
 * *connection* the isolation boundary, so three profiles each needed their own
 * `memory` — a workspace with three profiles came out of that migration holding
 * `memory.main`, `memory.work` and `memory.demo`, and the file read as
 * duplicated because it was. ADR-066 makes the *profile* the boundary, so one
 * row serves every profile and each still keeps its own bytes at
 * `profiles/<name>/lanes_memory/lan1/`. Merging the rows merges no notes, which
 * is exactly why contract 3 could not do it and this can.
 *
 * **Both sequences are numbered cleanly**, `con1..conN` over the accounts in
 * file order and `lan1..lan8` over the merged owner rows. A rerun produces the
 * same map because the order is the file's, and a row already carrying an
 * allocated id keeps it — this is not a renumbering, and running it twice must
 * not walk `con1` to `con2`.
 */
export function planRenames(
  connections: readonly { id: string; provider: string }[],
): Renames {
  const renames = new Map<string, string>();
  const taken = connections
    .map((row) => row.id)
    .filter((id) => /^(lan|con)[0-9]+$/.test(id));

  // One destination per owner-layer *provider*, so every profile's instance of
  // it lands on the same row.
  const merged = new Map<string, string>();

  for (const row of connections) {
    const owner = C3_OWNER_PROVIDERS.includes(row.provider);
    const provider = renamedProvider(row.provider);
    const from = `${row.provider}.${row.id}`;

    if (owner) {
      const already = merged.get(provider);
      if (already !== undefined) {
        renames.set(from, already);
        continue;
      }
    }

    const id = /^(lan|con)[0-9]+$/.test(row.id) ? row.id : nextConnectionId(taken, owner);
    if (!taken.includes(id)) taken.push(id);

    const to = `${provider}.${id}`;
    renames.set(from, to);
    if (owner) merged.set(provider, to);
  }

  return renames;
}

/** `memory` becomes `lanes_memory`; everything else keeps its id. */
export function renamedProvider(provider: string): string {
  return C3_OWNER_PROVIDERS.includes(provider) ? `lanes_${provider}` : provider;
}
