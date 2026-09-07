import { readConnections } from '#profile';
import type { Runtime } from '#cli/runtime.ts';
import type { ConnectionRow } from './state.ts';

/**
 * The workspace's connections, with the endpoint's own memory of them attached.
 *
 * Two sources with different jobs. `connections.yaml` is the authority for
 * *which* connections exist: it is what the operator wrote and what `connect`
 * appends to. The state store is the authority for *when*, because the file has
 * never carried a timestamp and a whole-file mtime cannot speak about one row.
 *
 * **The file wins on membership, always.** The state store is rebuilt from the
 * file by reconcile and its own header says it can be deleted at any time, so a
 * row it has not caught up with, or a store that will not open at all, must
 * leave the listing intact and the dates absent. That is what the `catch` is
 * for; it is not defensive habit.
 *
 * Both binds call this rather than each holding a copy of the join. Reaching
 * `primary.state` here is allowed where importing `#stores` would not be:
 * `architecture.test.ts` forbids the specifier, and the type arrives through
 * `Runtime`, which this surface already depends on.
 */
export async function connectionRows(primary: Runtime): Promise<readonly ConnectionRow[]> {
  const { connections } = await readConnections(primary.resolution.workspaceRoot);
  const records = await primary.state.connections.list().catch(() => []);
  const seen = new Map(records.map((record) => [`${record.provider}.${record.id}`, record]));

  return connections.map((row) => {
    const record = seen.get(`${row.provider}.${row.id}`);
    if (!record) return row;
    return {
      ...row,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  });
}
