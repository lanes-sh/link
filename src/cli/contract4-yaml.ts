import { CONNECTIONS_FILE, layout, readWorkspaceFile, workspaceFiles } from '#profile';
import { parseDocument } from 'yaml';
import { ConfigDocument } from './config-edit.ts';
import type { Renames } from './contract4-data.ts';

/**
 * The two YAML rewrites contract 4 makes, and the order between them.
 *
 * The grants go first and the rows second, with the stamp after both — every
 * window that leaves is one a rerun closes, because both rewrites are
 * idempotent: a grant or a row already naming the new ref is not in the map and
 * is left alone. Renaming the rows first destroyed the only source the map is
 * derived from, and the rerun then stamped a profile whose grants named a
 * connection nothing declared.
 */

/**
 * `memory.*` becomes `lanes_memory.*`, in either spelling a rule may take.
 *
 * A rule is a bare pattern string or `{ capability, expires_at }`, and an
 * expiry has to survive: dropping it would turn a lapsing grant into a
 * permanent one, which is the direction that fails unsafely.
 */
function retitle(rules: unknown, was: string, now: string): unknown {
  if (!Array.isArray(rules)) return rules;

  const moved = (pattern: string): string =>
    pattern === was || pattern.startsWith(`${was}.`) ? `${now}${pattern.slice(was.length)}` : pattern;

  return rules.map((rule) => {
    if (typeof rule === 'string') return moved(rule);
    const held = rule as { capability?: unknown };
    return typeof held.capability === 'string'
      ? { ...held, capability: moved(held.capability) }
      : rule;
  });
}

/**
 * Every profile's grants, onto the ids and providers the rename settled.
 *
 * Its own pass rather than a step inside the stamping loop, because the two
 * have to happen either side of `renameConnections` — the grants while the rows
 * still carry the old ids, the stamp once everything else is done.
 *
 * A rule may only name the provider its row grants (ADR-058), so the
 * `allow`/`deny` patterns move with the `connection` or the profile is one the
 * loader refuses.
 */
export async function rewriteGrants(
  root: string,
  profiles: readonly string[],
  renames: Renames,
): Promise<void> {
  for (const profile of profiles) {
    const document = await ConfigDocument.openKey(root, layout.profileConfig(profile));

    const held = document.toJSON() as { grants?: unknown };
    const grants = held.grants;
    if (!Array.isArray(grants)) continue;

    // **Deduplicated, because the owner layer merges.** Every profile's own
    // `memory` grant renames to `lanes_memory.lan1` (ADR-066), and a profile
    // that granted two instances of one surface would emit two rows at one
    // address — which `validateConfig` refuses, on the save below, after the
    // registry and every byte have already moved.
    const seen = new Set<string>();

    document.setIn(
      ['grants'],
      grants.flatMap((grant) => {
        const one = grant as { connection?: unknown; allow?: unknown; deny?: unknown };
        const ref = typeof one.connection === 'string' ? one.connection : undefined;
        if (ref === undefined) return [grant];

        const to = renames.get(ref) ?? ref;
        if (seen.has(to)) return [];
        seen.add(to);

        const was = ref.slice(0, ref.indexOf('.'));
        const now = to.slice(0, to.indexOf('.'));

        return [
          {
            ...one,
            connection: to,
            ...(was === now
              ? {}
              : { allow: retitle(one.allow, was, now), deny: retitle(one.deny, was, now) }),
          },
        ];
      }),
    );

    // `shapeOnly`, because the rows still name the old ids at this point and
    // `assertGrantsResolve` would refuse a grant it cannot yet resolve. The
    // secret-shaped-value check and the schema both still run.
    await document.save({ shapeOnly: true, contract: 3 });
  }
}

/** Every connection row, however far through the migration this workspace is. */
export async function readConnectionRows(
  root: string,
  full = false,
): Promise<{ id: string; provider: string; account: string; credential_ref?: string }[]> {
  const text = await readWorkspaceFile(workspaceFiles(root), CONNECTIONS_FILE);
  if (text === null) return [];

  const held = parseDocument(text).toJSON() as { connections?: unknown };
  if (!Array.isArray(held.connections)) return [];

  return held.connections.flatMap((row) => {
    const one = row as { id?: unknown; provider?: unknown; account?: unknown };
    if (typeof one.id !== 'string' || typeof one.provider !== 'string') return [];

    // `account` matters only to `credentialRefFor`, which reads a row's own
    // `credential_ref` off it; the id and provider are all the rest wants.
    return [
      {
        ...(full ? (row as object) : {}),
        id: one.id,
        provider: one.provider,
        account: typeof one.account === 'string' ? one.account : '',
      },
    ];
  });
}

/**
 * The ids, in `connections.yaml` and in the credential store's refs.
 *
 * A `credential_ref` defaults to `<provider>/<connection>` and is derived
 * rather than written, so the rows carry no ref to update — but a connection
 * that *declares* one, and every `oauth_apps` entry, is a string naming an id
 * and has to move with it.
 */
export async function renameConnections(root: string, renames: Renames): Promise<void> {
  const document = await ConfigDocument.openKey(root, CONNECTIONS_FILE);

  // `toJSON()`, not `getIn`: `getIn` hands back YAML nodes rather than plain
  // JS, so an `Array.isArray` on the result is false and the rewrite silently
  // does nothing — which is exactly what it did, and the migration reported
  // success with every id unchanged.
  const held = document.toJSON() as { connections?: unknown };
  if (!Array.isArray(held.connections)) return;

  // **Deduplicated, because the owner layer merges.** Three profiles' own
  // `memory` rows all rename to `lanes_memory.lan1` (ADR-066), and keeping
  // three of them would be three rows at one address — which
  // `assertConnectionsUnique` refuses, on the save at the end of this. The
  // first row wins and the rest are dropped; the *bytes* are not merged, they
  // land under each profile's own directory.
  const seen = new Set<string>();
  const rows = held.connections.flatMap((row) => {
    const one = row as { id?: unknown; provider?: unknown };
    if (typeof one.id !== 'string' || typeof one.provider !== 'string') return [row];

    const to = renames.get(`${one.provider}.${one.id}`);
    if (to === undefined) return [row];
    if (seen.has(to)) return [];
    seen.add(to);

    // Both halves. The provider moved for the owner layer (`memory` became
    // `lanes_memory`) and the id moved for everything unallocated, and a row
    // that took one without the other names a connection nothing resolves.
    const dot = to.indexOf('.');
    return [{ ...one, provider: to.slice(0, dot), id: to.slice(dot + 1) }];
  });

  // **Lanes' own rows last, and the accounts in file order.** Nothing reads the
  // order, but somebody does: interleaved, `con17` landed between `lan14` and
  // `lan15` and the file read as though the numbering had gone wrong.
  const owned = (row: unknown): boolean =>
    typeof (row as { provider?: unknown }).provider === 'string' &&
    (row as { provider: string }).provider.startsWith('lanes_');

  document.setIn(['connections'], [...rows.filter((r) => !owned(r)), ...rows.filter(owned)]);

  // The stamp this file was missing. Nothing reads it — every contract check is
  // on a profile — which is exactly why it went stale, and a marker that lies
  // is worse than no marker for whoever writes the next migration.
  document.setIn(['contract'], 4);

  await document.save();
}
