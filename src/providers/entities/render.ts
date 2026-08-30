import type { Catalogue, CatalogueEntity } from './catalogue.ts';
import { distinguish, type Candidate, type Criteria, type Matches } from './find.ts';

/**
 * How an answer reads, kept apart from what an answer is.
 *
 * `find.ts` decides which entities match; this decides what a person or a model
 * sees, and the two are separated because the interesting failures are
 * different in kind. A matching bug returns the wrong entity. A rendering bug
 * returns the right entity in a form that invites the wrong next move — a list
 * of two that reads like a recommendation of one, or an edge to something
 * undeclared silently omitted so the graph looks complete.
 *
 * Every function here is pure over a catalogue already in memory.
 */

/** One entity in full, for the answer an agent is about to act on. */
export function renderEntity(
  entity: CatalogueEntity,
  catalogue: Catalogue,
  body: string,
): string {
  const head = entity.type ? `${entity.name} — ${entity.type} (${entity.id})` : `${entity.name} (${entity.id})`;
  const lines: string[] = [head];

  if (entity.aliases.length > 0) lines.push(`Also known as ${entity.aliases.join(', ')}.`);
  if (entity.tags.length > 0) lines.push(`Tagged ${entity.tags.join(', ')}.`);

  if (entity.attributes.length > 0) {
    const kinds = [...new Set(entity.attributes.map((one) => one.kind))];
    const ordered = kinds.flatMap((kind) => entity.attributes.filter((one) => one.kind === kind));
    const width = Math.max(...ordered.map((one) => one.kind.length));

    lines.push('');
    // The kind is repeated on every line rather than written once as a heading,
    // for identity's reason: a line lifted out of this block on its own still
    // says what it is, and a model quoting one line is what happens next.
    for (const one of ordered) {
      const head = `  ${one.kind.padEnd(width)}  ${one.value}`;
      lines.push(one.note ? `${head}  — ${one.note}` : head);
    }

    if (kinds.some((kind) => entity.attributes.filter((one) => one.kind === kind).length > 1)) {
      lines.push('');
      lines.push(
        'Where a kind holds more than one, the first is the default and the notes say when to ' +
          'prefer another. If none of them fits what you are doing, ask rather than combining them.',
      );
    }
  }

  const edges = renderEdges(entity, catalogue);
  if (edges.length > 0) lines.push('', ...edges);

  if (body.trim().length > 0) lines.push('', body.trim());

  return lines.join('\n');
}

function renderEdges(entity: CatalogueEntity, catalogue: Catalogue): string[] {
  const lines: string[] = [];

  for (const relation of entity.relations) {
    lines.push(`  ${relation.predicate} → ${nameOf(catalogue, relation.entity)}${note(relation.note)}`);
  }

  for (const backlink of catalogue.backlinks.get(entity.id) ?? []) {
    lines.push(`  ← ${backlink.predicate} ${nameOf(catalogue, backlink.from)}${note(backlink.note)}`);
  }

  return lines;
}

/**
 * A declared entity by name and id; an undeclared one by id, said so.
 *
 * Never an error and never a dropped line: an edge to something not written
 * down yet is a fact the owner recorded, and hiding it would make the graph
 * quietly wrong rather than visibly incomplete.
 */
function nameOf(catalogue: Catalogue, id: string): string {
  const entity = catalogue.byId.get(id);
  return entity === undefined ? `${id} (not a declared entity)` : `${entity.name} (${id})`;
}

function note(text: string | undefined): string {
  return text === undefined ? '' : ` — ${text}`;
}

/** Several candidates: the count first, then only what tells them apart. */
export function renderCandidates(
  matches: Matches,
  criteria: Criteria,
  connection: string,
): string {
  const { candidates, total } = matches;
  const differing = distinguish(candidates);
  const idWidth = Math.max(...candidates.map((one) => one.entity.id.length));
  const nameWidth = Math.max(...candidates.map((one) => one.entity.name.length));

  const rows = candidates.map((candidate, index) => {
    const facets = differing[index] ?? [];
    const head = `  ${candidate.entity.id.padEnd(idWidth)}  ${candidate.entity.name.padEnd(nameWidth)}  ${candidate.matched}`;
    return facets.length > 0 ? `${head}  ·  ${facets.join('  ·  ')}` : head;
  });

  const nothing = differing.every((one) => one.length === 0);

  return [
    // The count leads, before any candidate: a client that truncates the
    // response must still have seen that there was more than one.
    `${total} entities match ${describe(criteria)} on \`${connection}\`.` +
      (total > candidates.length ? ` The first ${candidates.length} are below; raise \`limit\` for more.` : ''),
    '',
    ...rows,
    '',
    nothing
      ? 'Nothing here tells these apart beyond their ids — which usually means the owner has a ' +
        'duplicate to merge. Ask which is meant; do not pick one.'
      : 'If the context does not make it clear which is meant, ask before acting. Nothing here ' +
        'chooses between them, and the order is not a ranking.',
  ].join('\n');
}

/** What was asked for, in the words the caller used. */
export function describe(criteria: Criteria): string {
  const parts: string[] = [];

  if (criteria.query !== undefined) parts.push(`"${criteria.query}"`);
  if (criteria.type !== undefined) parts.push(`type ${criteria.type}`);
  if (criteria.tag !== undefined) parts.push(`tag ${criteria.tag}`);

  for (const one of criteria.attr ?? []) {
    parts.push(one.value === undefined ? `with a ${one.kind}` : `${one.kind} ${one.value}`);
  }
  for (const one of criteria.related ?? []) {
    const arrow = (one.direction ?? 'out') === 'in' ? '←' : '→';
    parts.push(`${one.predicate ?? 'related'} ${arrow} ${one.entity}`);
  }

  return parts.length === 0 ? 'no criteria' : parts.join(', ');
}
