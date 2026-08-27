/**
 * Spec surgery that is not about any one vendor.
 *
 * Two operations, both forced on us by the same property of
 * `mcp-from-openapi`: it **inlines** `$ref`s. That makes a generated input
 * schema cost what the reference graph below it costs, not what the document
 * says — so a cycle is unbounded recursion rather than a self-reference, and a
 * shared schema is duplicated at every use site.
 *
 * These lived inside `google/specs/vendor.ts` while Google was the only
 * vendored spec. bunq is the second, and it needs `cutCycles` more urgently
 * than Google does: bunq's published document fails to generate **55**
 * operations, every payment endpoint among them, because `Payment` recurses
 * through `RequestInquiry` and `RequestResponse`. Copying seventy lines into a
 * second script is how the two come to disagree about what a cycle is.
 *
 * `makeOpaque` was held back at first for a good reason: it writes a sentence
 * into the schema it replaces, and that sentence points at the vendor's own
 * reference documentation, which made it a Google function that happened to look
 * generic. Taking the sentence as a parameter is what actually settles that —
 * the surgery is generic, only the pointer was not — so it lives here now, with
 * each caller passing its own note. Discord is the third vendor to need it.
 */

/** The shape both vendoring scripts read and write. Generic OpenAPI 3.x. */
export interface Spec {
  openapi: string;
  info: Record<string, unknown>;
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, { operationId?: string } & Record<string, unknown>>>;
  components?: { schemas?: Record<string, unknown> } & Record<string, unknown>;
  [key: string]: unknown;
}

/** Every `$ref` target reachable from a value, transitively. */
export function referenced(root: unknown, schemas: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const queue: unknown[] = [root];

  while (queue.length > 0) {
    const node = queue.pop();
    if (node === null || typeof node !== 'object') continue;

    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = value.replace('#/components/schemas/', '');
        if (!found.has(name) && name in schemas) {
          found.add(name);
          queue.push(schemas[name]);
        }
        continue;
      }
      queue.push(value);
    }
  }

  return found;
}

/**
 * Cut reference cycles, replacing the back-edge with an open object.
 *
 * Gmail's `MessagePart` contains `MessagePart[]` — a MIME tree, so the
 * recursion is honest — and the OpenAPI tool generator inlines `$ref`s, so it
 * recurses until the stack ends. That silently costs the two draft-writing
 * operations, which are the useful half of `gmail.compose`.
 *
 * Cutting the back-edge rather than dropping the operation keeps the tool: the
 * field that matters for creating a draft is `raw`, an RFC 2822 message, and
 * nothing below the cut is required to fill it in. A depth-first walk marks the
 * names currently on the path, and any `$ref` reaching back to one of them
 * becomes a plain object.
 */
export function cutCycles(schemas: Record<string, unknown>): number {
  let cuts = 0;

  const walk = (node: unknown, path: Set<string>): void => {
    if (node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, path);
      return;
    }

    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = value.replace('#/components/schemas/', '');
        if (path.has(name)) {
          delete record['$ref'];
          record['type'] = 'object';
          record['additionalProperties'] = true;
          record['description'] = `A nested ${name}. Structure omitted: it recurses.`;
          cuts++;
        } else if (name in schemas) {
          walk(schemas[name], new Set([...path, name]));
        }
        continue;
      }
      walk(value, path);
    }
  };

  for (const [name, schema] of Object.entries(schemas)) walk(schema, new Set([name]));
  return cuts;
}

/**
 * Replace a named schema with an open object.
 *
 * Same device as `cutCycles` and a different disease. That one cuts recursion;
 * this one cuts *fan-out*. Because `$ref`s are inlined, a union of eighty
 * variants — each with its own nested grid, filter, and chart schemas, sharing
 * sub-schemas that inlining duplicates per occurrence — costs orders of
 * magnitude more generated than it does on disk.
 *
 * Measured on the worst case in the repository: one spreadsheet operation
 * generated a 2,469KB input schema against 45KB for a whole other API. That is
 * unusable — it would be sent on every `tools/list` — and it was also the only
 * operation that could add a tab, freeze a header, or format a cell, so
 * dropping it was no better.
 *
 * Opaque keeps the operation for a few KB. The agent fills the field in from the
 * API it already knows, which is the same bet `raw` makes for a mail draft: a
 * well-known wire format is cheaper described than schematised. `note` carries
 * the pointer to the vendor's reference, because that is the only thing lost.
 *
 * Apply before `referenced`, so the schemas that were reachable only through the
 * replaced one leave the document entirely rather than lingering unused.
 */
export function makeOpaque(
  schemas: Record<string, unknown>,
  names: readonly string[],
  note: string,
): number {
  let replaced = 0;

  for (const name of names) {
    if (!(name in schemas)) continue;
    const original = schemas[name] as { description?: string };
    schemas[name] = {
      type: 'object',
      additionalProperties: true,
      description: `${original.description ?? `A ${name}.`} ${note}`,
    };
    replaced++;
  }

  return replaced;
}
