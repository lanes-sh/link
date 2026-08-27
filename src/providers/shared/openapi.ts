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
 * Deliberately not moved: `makeOpaque`. It writes a sentence into the schema it
 * replaces, and that sentence points at the vendor's own reference
 * documentation — which makes it a Google function that happens to look
 * generic.
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
