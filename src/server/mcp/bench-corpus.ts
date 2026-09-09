import { readFileSync } from 'node:fs';
import type { MergedCapability } from './visibility.ts';

/**
 * A surface to rank against, and the questions people actually ask of it.
 *
 * Harvested rather than written. `bench/harvest.ts` reads every vendored
 * OpenAPI document this repository ships and the owner layer's own
 * declarations, and `bench/corpus.ts` replaces the vendors' names and anything
 * shaped like an address — so what is left is a hundred and sixty-six real
 * operations described in their vendors' own register, which is the one
 * property a hand-written fixture cannot have. A fixture author writes
 * descriptions that distinguish; an API writes descriptions that document, and
 * the difference is the whole problem.
 *
 * What it reproduces, and what a smaller fixture cannot:
 *
 * - **Crowding by domain.** Two mail providers, two calendars, two contact
 *   stores, two file stores, and three separate places a task can live. Nearly
 *   every question has a right answer in more than one provider, so the
 *   ranking cannot succeed by picking a vendor.
 * - **Two naming conventions at once.** One mail provider calls it
 *   `users.messages.list`, the other `me.ListMessages`. A query in English
 *   resembles neither.
 * - **The shared tail.** A provider's declared keywords are appended to every
 *   one of its capabilities identically, which is what makes the provider
 *   findable and what makes its capabilities indistinguishable.
 *
 * Regenerate with `bun run bench:corpus`. It is committed rather than built at
 * test time so a spec refresh cannot silently move the numbers.
 */

type Corpus = {
  entries: { id: string; title: string; description: string; properties: string[]; required: string[] }[];
  queries: { query: string; expect: string[]; kind: 'read' | 'write' }[];
};

const loaded = JSON.parse(
  readFileSync(new URL('./bench-corpus.json', import.meta.url), 'utf8'),
) as Corpus;

/** The corpus as the endpoint holds it — one merged capability per operation. */
export const CORPUS: Map<string, MergedCapability> = new Map(
  loaded.entries.map((entry) => [
    entry.id,
    {
      reachable: new Map([['personal', [`${entry.id.split('.')[0]}.acct1`]]]),
      capability: undefined,
      discovered: {
        name: 'ignored',
        title: entry.title,
        description: entry.description,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(entry.properties.map((name) => [name, { type: 'string' }])),
          required: entry.required,
        },
      },
    } as unknown as MergedCapability,
  ]),
);

/**
 * What a person asks, and every capability that would be a right answer.
 *
 * More than one is listed wherever the surface genuinely has more than one, and
 * that is not a weakening of the test. Two mail accounts are connected and a
 * query naming neither has no basis for preferring one — asserting a vendor
 * there would assert a preference the endpoint cannot justify. What is asserted
 * is the *operation*: enumerating a mailbox, never fetching one message by an
 * id the caller has not got.
 */
export const QUERIES: readonly { query: string; expect: string[]; kind: 'read' | 'write' }[] =
  loaded.queries;

/** The read half, which is most of it and the half an agent spends its turns on. */
export const READS = QUERIES.filter((question) => question.kind === 'read');
