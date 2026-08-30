import { z } from 'zod';
import {
  defineLocalProvider,
  keepKeys,
  type BlobStore,
  type ProviderDefinition,
} from '#connectivity';
import {
  openCatalogue,
  rebuildCatalogue,
  type Catalogue,
  type CatalogueEntity,
} from './catalogue.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, matchEntities, type Criteria } from './find.ts';
import { describe, renderCandidates, renderEntity } from './render.ts';
import { readEntity, type Entity } from './store.ts';
import { writeCapabilities } from './writes.ts';

/**
 * `entities` — who and what everyone else is.
 *
 * `identity` declares who the *owner* is, because an agent writing as them was
 * otherwise inferring a name from whatever was in the conversation (ADR-042).
 * The same failure happens one step outward and nothing catches it: asked to
 * "email Jan about the invoice", an agent reaches for an address it saw in a
 * thread. The information is knowable; there was nowhere to write it down.
 *
 * **`find` answers with everything that matches and never chooses.** One match
 * is an answer; several is a question for the owner, and the response shows
 * what *separates* the candidates so that question can usually be settled from
 * context rather than asked. Several matches is a normal outcome and carries no
 * error — an assistant handed two people called Jan asks which one, it does not
 * fail. What is refused is silently picking one.
 *
 * **Reading and writing are separate capabilities**, following `memory` and
 * ADR-012 §2. A writable store persists injections: an instruction written once
 * is re-served to every later session, including to a different agent. That
 * argument applies here with a twist worth naming — an entity is *acted on*, so
 * a bad write is not only re-served, it is used to address a message. The write
 * bundle is not default, and `deny` takes three rules to close
 * (`entities.write`, `entities.link`, `entities.forget`), not one.
 *
 * Unlike `identity`, this **is** agent-writable, and the two are not
 * inconsistent. ADR-050's test for a default grant is not "is it empty" but
 * "can it be filled in from here": identity is configuration and changed in the
 * CLI (ADR-007), so an agent able to edit it could edit the one fact that stops
 * it signing as the wrong person. Everyone else's details are ordinary owner
 * material, accumulated in conversation, on the same surface that reads them.
 *
 * Storage is `store.ts`, the derived index is `catalogue.ts`, matching is
 * `find.ts` and wording is `render.ts`. This file is only the surface: schemas,
 * bundles, redaction, and what reaches the audit log.
 */

const DESCRIPTION =
  'The people, companies and projects the owner deals with, with their canonical addresses and ' +
  'handles. Call entities.find before acting on a name: it returns every match and never chooses, ' +
  'so more than one means ask rather than take the first.';

export const entitiesProvider: ProviderDefinition = defineLocalProvider({
  id: 'entities',
  name: 'Entities',
  version: '1.0.0',
  description: DESCRIPTION,

  configSchema: z.object({}),
  connectionSchema: z.object({}),

  bundles: [
    {
      name: 'read',
      description: 'Look entities up and read them.',
      oauth_scopes: [],
      capabilities: ['entity', 'find', 'get'],
      default: true,
    },
    {
      // Not in the default bundle — see the provider docstring. Denying it
      // takes all three names; there is no single rule that covers them.
      name: 'write',
      description: 'Declare, relate and remove entities.',
      oauth_scopes: [],
      capabilities: ['write', 'link', 'forget'],
    },
  ],

  capabilities: [
    /**
     * Retrieval by address — a resource, not a tool (ADR-006).
     *
     * Not optional, and not decoration: `resourceLinkRouter` builds its set of
     * routable origins from this provider's own `uriTemplate`s and returns the
     * identity function when there are none. Without it every `resource_link`
     * below would reach the client naming no profile and no connection, which
     * no client can read.
     */
    {
      kind: 'resource',
      name: 'entity',
      title: 'Entity',
      description: 'One declared entity, addressed by its id.',
      uriTemplate: 'entities://entity/{id}',
      mimeType: 'text/markdown',
      redact: keepKeys('uri'),

      async list(context) {
        const catalogue = await openCatalogue(context.storage);
        return catalogue.entities.map((entity) => ({
          uri: `entities://entity/${encodeURIComponent(entity.id)}`,
          name: entity.name,
        }));
      },

      async read(uri, params, context) {
        const raw = params['id'];
        if (!raw) throw new Error(`Malformed entities URI: ${uri}`);

        const id = decodeURIComponent(raw);
        const entity = await readEntity(context.storage, id);
        if (entity === null) throw new Error(`No entity "${id}" on ${context.connection.key}`);

        const catalogue = await openCatalogue(context.storage);
        return { uri, mimeType: 'text/markdown', text: renderEntity(entity, catalogue, entity.body) };
      },
    },

    {
      kind: 'tool',
      name: 'find',
      title: 'Look up an entity',
      description:
        'Find entities by name, alias, address, type, tag, attribute or relationship. All criteria ' +
        'given are combined. Returns every match: exactly one is an answer, several means ask which ' +
        'is meant rather than taking the first, and the order is not a ranking. Call this before ' +
        'using anyone’s address rather than recalling one.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('A name, alias, id or address. Matched exactly first, then by prefix and substring.'),
        type: z.string().optional().describe('Restrict to one type, e.g. person, company, project'),
        tag: z.string().optional().describe('Restrict to entities carrying this tag'),
        attr: z
          .array(
            z.object({
              kind: z.string().min(1).describe('Attribute kind, e.g. email, github'),
              value: z.string().optional().describe('Omit to mean "has this kind at all"'),
            }),
          )
          .optional()
          .describe('Restrict to entities carrying these attributes'),
        related: z
          .array(
            z.object({
              predicate: z.string().optional().describe('Edge name, e.g. works_at. Omit for any.'),
              entity: z.string().min(1).describe('The entity id on the other end'),
              direction: z
                .enum(['out', 'in', 'any'])
                .optional()
                .describe('out (default): this entity points at the named one'),
            }),
          )
          .optional()
          .describe('Restrict by relationship, one hop'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Maximum results (default ${DEFAULT_LIMIT})`),
      }),
      /**
       * The query is withheld; the outcome is annotated instead.
       *
       * A lookup string here is frequently a third party's address, typed by
       * someone who never wrote it down — the same class of thing
       * `memory.search` withholds its query for. The ids that came back are the
       * more useful record anyway: they are stable across spellings, and now
       * that several matches is a normal outcome the log should show that two
       * candidates were offered and which, so a later wrong message is
       * traceable to the moment the choice was made.
       */
      redact: keepKeys('type', 'tag', 'limit'),
      async handler({ query, type, tag, attr, related, limit }, context) {
        const criteria: Criteria = { query, type, tag, attr, related, limit };

        let catalogue = await openCatalogue(context.storage);
        let matches = matchEntities(catalogue, criteria);

        // Confirm-on-read: one candidate, served from an index, is the only
        // shape where a wrong answer gets acted on. See `reconcile`.
        const only = matches.candidates.length === 1 ? matches.candidates[0] : undefined;
        if (catalogue.fromIndex && only !== undefined) {
          const rebuilt = await reconcile(context.storage, catalogue, only.entity);
          if (rebuilt !== null) {
            context.log.debug('entities: index disagreed with a matched file, rebuilt');
            catalogue = rebuilt;
            matches = matchEntities(catalogue, criteria);
          }
        }

        context.audit.annotate({
          scanned: matches.scanned,
          matched: matches.total,
          candidates: matches.candidates.map((one) => one.entity.id),
        });

        if (matches.candidates.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Nothing on ${context.connection.key} matches ${describe(criteria)}. ` +
                  'Do not use an address that is not here — `entities.write` declares a new one, ' +
                  'or ask the owner.',
              },
            ],
          };
        }

        if (matches.candidates.length > 1) {
          return {
            content: [
              { type: 'text', text: renderCandidates(matches, criteria, context.connection.key) },
              ...matches.candidates.map((one) => ({
                type: 'resource_link' as const,
                uri: `entities://entity/${encodeURIComponent(one.entity.id)}`,
                name: one.entity.name,
              })),
            ],
          };
        }

        const found = matches.candidates[0]!.entity;
        const file = await readEntity(context.storage, found.id);

        return {
          content: [
            {
              type: 'resource_link' as const,
              uri: `entities://entity/${encodeURIComponent(found.id)}`,
              name: found.name,
            },
            { type: 'text', text: renderEntity(found, catalogue, file?.body ?? '') },
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'get',
      title: 'Read one entity',
      description:
        'Return one entity by id, with its relationships and everything pointing at it. The resource ' +
        'entities://entity/{id} is the same content; this exists for clients that do not read resources.',
      inputSchema: z.object({ id: z.string().min(1).describe('Entity id') }),
      redact: keepKeys('id'),
      async handler({ id }, context) {
        const entity = await readEntity(context.storage, id);
        if (entity === null) {
          return {
            content: [{ type: 'text', text: `No entity "${id}" on ${context.connection.key}.` }],
            isError: true,
          };
        }

        const catalogue = await openCatalogue(context.storage);
        return { content: [{ type: 'text', text: renderEntity(entity, catalogue, entity.body) }] };
      },
    },

    ...writeCapabilities,
  ],
});

/**
 * Re-check a single match against its own file before an agent acts on it.
 *
 * The index's fingerprint stamps the *entity files*, so an index edited on its
 * own — by hand, or corrupted in a way that still parses — passes it and is
 * served. That is the accepted cost of keeping the index beside the documents,
 * and this is where it is paid back: on the one path where an answer is about
 * to be used to address something, the file is opened and compared. One extra
 * read, which `get` would have cost anyway.
 *
 * On any disagreement the whole catalogue is rebuilt and the search re-run,
 * rather than the one row being patched. Patching would answer with an entity
 * that no longer matches what was asked for — the index may have been the only
 * reason it matched — and "here is your one result" is exactly the wrong thing
 * to say then. Re-running can legitimately return none, or several; both are
 * better answers than a confident wrong one.
 *
 * Not done when there are several candidates: nothing is being acted on yet,
 * and `get` reads the file.
 */
async function reconcile(
  storage: BlobStore,
  catalogue: Catalogue,
  candidate: CatalogueEntity,
): Promise<Catalogue | null> {
  const file = await readEntity(storage, candidate.id);
  if (file !== null && canonical(strip(file)) === canonical(candidate)) return null;

  return rebuildCatalogue(storage);
}

function strip(entity: Entity): CatalogueEntity {
  const { body: _body, bytes: _bytes, ...row } = entity;
  return row;
}

/**
 * Everything about a row that could have decided the match, as one string.
 *
 * Written out field by field rather than `JSON.stringify(row)` so the
 * comparison does not depend on two parsers inserting keys in the same order —
 * a difference that would read as a disagreement and rebuild on every call.
 */
function canonical(row: CatalogueEntity): string {
  return JSON.stringify([
    row.type,
    row.name,
    [...row.aliases],
    [...row.tags],
    row.attributes.map((one) => [one.kind, one.value, one.note ?? '']),
    row.relations.map((one) => [one.predicate, one.entity, one.note ?? '']),
    row.updatedAt,
  ]);
}

export default entitiesProvider;
