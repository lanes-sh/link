import type { Backlink, Catalogue, CatalogueEntity } from './catalogue.ts';

/**
 * What a name means, and what happens when it means more than one thing.
 *
 * This is the whole reason the component exists, so the rules are stated here
 * rather than distributed through the handlers:
 *
 * **Several matches is a normal answer, not an error.** An assistant handed two
 * people called Jan asks which one; it does not fail. So `find` returns every
 * candidate and sets no error, and what it refuses to do is *choose*.
 *
 * **Ordering is not selection.** Candidates are ranked so the list is legible —
 * an exact id above a substring — and nothing in the response presents the
 * first as the answer. There is deliberately no scoring inside a rank: no
 * most-recently-updated tiebreak that would quietly promote one of two exact
 * alias matches. `updatedAt` orders *within* a rank and never across. This is
 * the one thing a later contributor will be tempted to improve into a silent
 * pick.
 *
 * **Exact suppresses approximate.** If anything matched exactly, prefix and
 * substring candidates are dropped. That is a boundary between *kinds* of
 * match, not a precedence among equals: two exact alias matches both survive,
 * and both are returned.
 *
 * **A tag is never matched by `query`.** A tag is a category, not an identity,
 * so `find("client")` must not surface one of eleven clients as if it were a
 * name. Filter by `tag` to mean the category.
 *
 * Everything here is pure and synchronous over a catalogue already in memory,
 * which is what lets the interesting cases — ambiguity, dangling edges,
 * preference order — be tested with literal arrays and no I/O.
 */

export type Direction = 'out' | 'in' | 'any';

export interface AttributeCriterion {
  readonly kind: string;
  /** Omitted means "has this kind at all", which is a useful browse. */
  readonly value?: string | undefined;
}

export interface RelationCriterion {
  /** Omitted means any predicate. */
  readonly predicate?: string | undefined;
  readonly entity: string;
  /**
   * `out` — the candidate declares an edge *to* `entity`. The default, because
   * it is what the natural phrasing means: "who works at Acme" wants Acme's
   * employees and not Acme.
   */
  readonly direction?: Direction | undefined;
}

/**
 * Every field optional, and explicitly `| undefined`.
 *
 * The handler destructures its validated input and hands the pieces straight
 * here, so a criterion the caller omitted arrives as `undefined` rather than
 * being absent — writing that out is what lets the surface stay a one-line
 * pass-through instead of six conditional spreads.
 */
export interface Criteria {
  readonly query?: string | undefined;
  readonly type?: string | undefined;
  readonly tag?: string | undefined;
  readonly attr?: readonly AttributeCriterion[] | undefined;
  readonly related?: readonly RelationCriterion[] | undefined;
  readonly limit?: number | undefined;
}

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

/**
 * How a candidate matched, in the order a list shows them.
 *
 * Ranks 1-4 are what a lookup means. 5 and 6 exist so a browse is useful, and
 * are dropped entirely whenever anything above them matched.
 */
const RANKS = ['id', 'name', 'alias', 'attribute', 'prefix', 'substring'] as const;
export type Rank = (typeof RANKS)[number];

const APPROXIMATE: readonly Rank[] = ['prefix', 'substring'];

export interface Candidate {
  readonly entity: CatalogueEntity;
  readonly rank: Rank;
  /** The field that matched, as a person would say it: `alias "Jan"`, `email`. */
  readonly matched: string;
}

export interface Matches {
  readonly candidates: readonly Candidate[];
  /** How many matched before `limit` cut the list. */
  readonly total: number;
  /** How many entities were considered, for the audit annotation. */
  readonly scanned: number;
}

/**
 * Normalised for comparison: trimmed, NFC, lowercased.
 *
 * NFC because a name typed with a combining accent in one place and precomposed
 * in another is the same person, and this is the only comparison in the
 * provider where that difference can decide an identity.
 */
function fold(text: string): string {
  return text.trim().normalize('NFC').toLowerCase();
}

export function matchEntities(catalogue: Catalogue, criteria: Criteria): Matches {
  const filtered = catalogue.entities.filter((entity) => passesFilters(catalogue, entity, criteria));

  const query = criteria.query === undefined ? '' : fold(criteria.query);
  const matched: Candidate[] = [];

  for (const entity of filtered) {
    if (query.length === 0) {
      matched.push({ entity, rank: 'name', matched: 'listed' });
      continue;
    }
    const candidate = rankOf(entity, query);
    if (candidate !== null) matched.push(candidate);
  }

  const exact = matched.filter((one) => !APPROXIMATE.includes(one.rank));
  const kept = exact.length > 0 ? exact : matched;

  kept.sort(
    (a, b) =>
      RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank) ||
      b.entity.updatedAt.localeCompare(a.entity.updatedAt),
  );

  const limit = Math.min(Math.max(criteria.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  return { candidates: kept.slice(0, limit), total: kept.length, scanned: catalogue.entities.length };
}

/** All criteria present are AND-ed. None of them looks at `query`. */
function passesFilters(
  catalogue: Catalogue,
  entity: CatalogueEntity,
  criteria: Criteria,
): boolean {
  if (criteria.type !== undefined && fold(entity.type) !== fold(criteria.type)) return false;

  if (criteria.tag !== undefined && !entity.tags.some((tag) => fold(tag) === fold(criteria.tag!))) {
    return false;
  }

  for (const want of criteria.attr ?? []) {
    const present = entity.attributes.some(
      (attribute) =>
        fold(attribute.kind) === fold(want.kind) &&
        (want.value === undefined || fold(attribute.value) === fold(want.value)),
    );
    if (!present) return false;
  }

  for (const want of criteria.related ?? []) {
    if (!relatedTo(catalogue, entity, want)) return false;
  }

  return true;
}

function relatedTo(
  catalogue: Catalogue,
  entity: CatalogueEntity,
  want: RelationCriterion,
): boolean {
  const direction = want.direction ?? 'out';
  const target = fold(want.entity);
  const predicate = want.predicate === undefined ? null : fold(want.predicate);

  const out = entity.relations.some(
    (relation) =>
      fold(relation.entity) === target &&
      (predicate === null || fold(relation.predicate) === predicate),
  );
  if (direction === 'out') return out;

  const into = (catalogue.backlinks.get(entity.id) ?? []).some(
    (backlink) =>
      fold(backlink.from) === target &&
      (predicate === null || fold(backlink.predicate) === predicate),
  );

  return direction === 'in' ? into : out || into;
}

/** The strongest way this entity matches the query, or null. */
function rankOf(entity: CatalogueEntity, query: string): Candidate | null {
  if (fold(entity.id) === query) return { entity, rank: 'id', matched: 'id' };
  if (fold(entity.name) === query) return { entity, rank: 'name', matched: 'name' };

  const alias = entity.aliases.find((one) => fold(one) === query);
  if (alias !== undefined) return { entity, rank: 'alias', matched: `alias "${alias}"` };

  const attribute = entity.attributes.find((one) => fold(one.value) === query);
  if (attribute !== undefined) {
    return { entity, rank: 'attribute', matched: attribute.kind };
  }

  const prefixed = [entity.name, ...entity.aliases].find((one) => fold(one).startsWith(query));
  if (prefixed !== undefined) return { entity, rank: 'prefix', matched: `starts with "${query}"` };

  const haystack = [entity.name, ...entity.aliases, ...entity.attributes.map((one) => one.value)];
  if (haystack.some((one) => fold(one).includes(query))) {
    return { entity, rank: 'substring', matched: `contains "${query}"` };
  }

  return null;
}

/**
 * The fields that actually differ across a set of candidates.
 *
 * This is what makes several matches a usable answer rather than a dump. Two
 * people called Jan separated by their employer is a question the surrounding
 * context usually settles; two rows of identical detail is not, and printing
 * everything about both buries the one column that would have decided it.
 *
 * Fields shared by every candidate are omitted for that reason, not to save
 * space. An attribute *value* that no criterion named is never rendered here —
 * disambiguating two people by printing three people's phone numbers is worse
 * than the ambiguity.
 */
export function distinguish(candidates: readonly Candidate[]): string[][] {
  const facets = candidates.map(facetsOf);
  const keys = [...new Set(facets.flatMap((one) => [...one.keys()]))];

  const differing = keys.filter((key) => {
    const values = facets.map((one) => one.get(key) ?? '');
    return values.some((value) => value !== values[0]);
  });

  return facets.map((one) =>
    differing.flatMap((key) => {
      const value = one.get(key);
      return value === undefined ? [] : [`${key} ${value}`];
    }),
  );
}

/** One candidate's comparable surface: type, tags, attribute kinds, edges. */
function facetsOf(candidate: Candidate): Map<string, string> {
  const facets = new Map<string, string>();
  const { entity } = candidate;

  if (entity.type) facets.set('type', entity.type);
  if (entity.tags.length > 0) facets.set('tags', [...entity.tags].sort().join(', '));

  for (const kind of new Set(entity.attributes.map((one) => one.kind))) {
    const values = entity.attributes.filter((one) => one.kind === kind).map((one) => one.value);
    facets.set(kind, values.join(', '));
  }

  for (const predicate of new Set(entity.relations.map((one) => one.predicate))) {
    const targets = entity.relations
      .filter((one) => one.predicate === predicate)
      .map((one) => one.entity);
    facets.set(`${predicate} →`, targets.join(', '));
  }

  return facets;
}
