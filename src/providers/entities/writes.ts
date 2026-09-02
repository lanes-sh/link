import { z } from 'zod';
import { keepKeys, type BlobStore, type Capability } from '#connectivity';
import { fingerprintAfter, openCatalogue, writeCatalogue, type Catalogue } from './catalogue.ts';
import {
  assertEntityId,
  assertKind,
  entityKey,
  readEntity,
  slugify,
  writeEntity,
  type Attribute,
  type Entity,
  type Relation,
} from './store.ts';

/**
 * The three capabilities that change something, and the index maintenance they
 * share.
 *
 * Their own file because the file boundary is the *bundle* boundary, and the
 * bundle boundary is the security argument: `read` is default and this is not
 * (ADR-012 §2). A reader deciding whether an agent should hold `entities.write`
 * has one file to read, and a grep for what an agent with only the default
 * bundle can do does not have to distinguish handlers inside one long list.
 *
 * All three go through `persist`, so there is one implementation of "write an
 * entity and leave the index describing what is now there".
 */

export const writeCapabilities: readonly Capability[] = [
    {
      kind: 'tool',
      name: 'write',
      title: 'Declare or update an entity',
      description:
        'Create an entity, or update one that exists. A field you do not supply is left as it is — ' +
        'send attributes: [] to clear them deliberately. Attribute order is preference order: the ' +
        'first of a kind is the default. Separate from reading, because what is written here is used ' +
        'to address messages in every later session.',
      inputSchema: z.object({
        name: z.string().min(1).describe('How the owner refers to this entity'),
        id: z
          .string()
          .optional()
          .describe('Entity id. Derived from the name when omitted; naming an existing one updates it.'),
        type: z.string().optional().describe('person, company, project — or anything else'),
        aliases: z.array(z.string()).optional().describe('Other names this is known by'),
        tags: z.array(z.string()).optional().describe('Labels for filtering'),
        attributes: z
          .array(
            z.object({
              kind: z.string().min(1).describe('email, github, phone — lowercase, no spaces'),
              value: z.string().min(1),
              note: z.string().optional().describe('When to use this one rather than another'),
            }),
          )
          .optional()
          .describe('Addresses and handles, most-preferred first'),
        relations: z
          .array(
            z.object({
              predicate: z.string().min(1).describe('works_at, owns, part_of'),
              entity: z.string().min(1).describe('The entity id on the other end'),
              note: z.string().optional(),
            }),
          )
          .optional()
          .describe('Edges from this entity. Replaces the existing set; entities.link appends one.'),
        notes: z.string().optional().describe('Free prose about this entity, as Markdown'),
      }),
      // The id, type and name are addresses — and `id` is `slugify(name)`, so
      // keeping one while withholding the other would be theatre. Every value
      // is withheld; `annotate` records the shape instead.
      redact: keepKeys('id', 'type', 'name', 'tags'),
      async handler(
        { name, id: given, type, aliases, tags, attributes, relations, notes },
        context,
      ) {
        const id = given ?? slugify(name);
        assertEntityId(id);
        for (const one of attributes ?? []) assertKind(one.kind, 'kind');
        for (const one of relations ?? []) assertKind(one.predicate, 'predicate');

        const existing = await readEntity(context.storage, id);
        // A field that was not supplied keeps what is on disk. Spelled out
        // rather than merged generically, because the alternative — a model
        // resending an entity minus an attribute it forgot — is a lost update
        // with a language model holding the pen.
        const next: Entity = {
          id,
          name,
          type: type ?? existing?.type ?? '',
          aliases: aliases ?? existing?.aliases ?? [],
          tags: tags ?? existing?.tags ?? [],
          attributes: (attributes ?? existing?.attributes ?? []) as readonly Attribute[],
          relations: (relations ?? existing?.relations ?? []) as readonly Relation[],
          updatedAt: new Date().toISOString(),
          body: notes ?? existing?.body ?? '',
          bytes: 0,
        };

        await persistEntity(context.storage, next);

        // `redact` maps keys to keep-or-typemark and cannot express "keep the
        // shape of this list, drop its values" — left to it alone, the log
        // would record `<array:3>` and say nothing about what changed. The
        // kinds are the reviewable fact; the addresses stay out of an
        // append-only hash-chained log. ADR-017.
        context.audit.annotate({
          entity: id,
          created: existing === null,
          attributes: next.attributes.length,
          kinds: [...new Set(next.attributes.map((one) => one.kind))],
          relations: next.relations.length,
        });

        return {
          content: [
            {
              type: 'text',
              text: `${existing === null ? 'Declared' : 'Updated'} "${id}" on ${context.connection.key}.`,
            },
            { type: 'resource_link', uri: `lanes-entities://entity/${id}`, name },
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'link',
      title: 'Relate one entity to another',
      description:
        'Add one edge to an entity, leaving everything else on it alone. The edge is written only on ' +
        'the entity it comes from; the reverse direction is derived, so do not also write it the other ' +
        'way. The other end need not exist yet.',
      inputSchema: z.object({
        from: z.string().min(1).describe('Entity id the edge comes from'),
        predicate: z.string().min(1).describe('works_at, owns, part_of'),
        to: z.string().min(1).describe('Entity id the edge points at'),
        note: z.string().optional(),
      }),
      redact: keepKeys('from', 'predicate', 'to'),
      async handler({ from, predicate, to, note }, context) {
        assertKind(predicate, 'predicate');

        const entity = await readEntity(context.storage, from);
        if (entity === null) {
          return {
            content: [{ type: 'text', text: `No entity "${from}" on ${context.connection.key}.` }],
            isError: true,
          };
        }

        const already = entity.relations.some(
          (one) => one.predicate === predicate && one.entity === to,
        );
        if (already) {
          return {
            content: [{ type: 'text', text: `"${from}" already ${predicate} "${to}".` }],
          };
        }

        const relation: Relation = { predicate, entity: to, ...(note === undefined ? {} : { note }) };
        const next: Entity = {
          ...entity,
          relations: [...entity.relations, relation],
          updatedAt: new Date().toISOString(),
        };

        const catalogue = await persistEntity(context.storage, next);

        // Recorded because a dangling edge is legal and useful, and is also how
        // a typo in an id looks. The log is where that becomes visible.
        const dangling = !catalogue.byId.has(to);
        context.audit.annotate({ dangling });

        return {
          content: [
            {
              type: 'text',
              text:
                `"${from}" ${predicate} "${to}".` +
                (dangling ? ` "${to}" is not declared yet — the edge is kept as written.` : ''),
            },
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'forget',
      title: 'Remove an entity',
      description:
        'Delete an entity. Edges pointing at it from other entities are left alone and are reported, ' +
        'so nothing else is rewritten behind your back — clean them up deliberately if you mean to.',
      inputSchema: z.object({ id: z.string().min(1).describe('Entity id') }),
      redact: keepKeys('id'),
      async handler({ id }, context) {
        const catalogue = await openCatalogue(context.storage);
        const existed = catalogue.byId.has(id);
        const referencedBy = (catalogue.backlinks.get(id) ?? []).map((one) => one.from);

        context.audit.annotate({ existed, referenced_by: referencedBy.length });

        if (!existed) {
          return {
            content: [{ type: 'text', text: `No entity "${id}" on ${context.connection.key}.` }],
            isError: true,
          };
        }

        await forgetEntity(context.storage, catalogue, id, new Date().toISOString());

        // Deliberately not a cascade: a delete that rewrote five other people's
        // files could not be reviewed as one change. Saying who still points
        // here is what keeps the breakage from being silent.
        return {
          content: [
            {
              type: 'text',
              text:
                `Removed "${id}" from ${context.connection.key}.` +
                (referencedBy.length > 0
                  ? ` Still referenced by ${referencedBy.join(', ')} — those edges now dangle.`
                  : ''),
            },
          ],
        };
      },
    },
];

/**
 * Write one entity and the index that describes the store afterwards.
 *
 * The fingerprint is computed from the listing taken *before* the put plus the
 * byte length being written, so there is no second `list()` and no read-back —
 * see `catalogue.ts` for why `key:size` is what makes that possible.
 *
 * Exported because `lanes link entities write` needs exactly this and an
 * earlier version of it had its own: a rebuild-then-write that read every file
 * on every call, which is one extra pass by hand and a quadratic bulk load from
 * a script. Two implementations of index maintenance is the same drift the
 * shared `entityStorage` exists to prevent, one layer up.
 */
export async function persistEntity(storage: BlobStore, entity: Entity): Promise<Catalogue> {
  const catalogue = await openCatalogue(storage);
  const bytes = await writeEntity(storage, entity);

  const { body: _body, bytes: _bytes, ...row } = entity;
  const rows = [...catalogue.entities.filter((one) => one.id !== entity.id), row];

  await writeCatalogue(
    storage,
    rows,
    fingerprintAfter(catalogue.listing, { key: entityKey(entity.id), size: bytes }),
    entity.updatedAt,
  );

  return catalogue;
}

/** Remove one entity and leave the index describing what is left. */
export async function forgetEntity(
  storage: BlobStore,
  catalogue: Catalogue,
  id: string,
  now: string,
): Promise<void> {
  await storage.delete(entityKey(id));
  await writeCatalogue(
    storage,
    catalogue.entities.filter((one) => one.id !== id),
    fingerprintAfter(catalogue.listing, { key: entityKey(id), deleted: true }),
    now,
  );
}
