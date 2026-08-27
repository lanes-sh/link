/**
 * Trim an upstream OpenAPI document down to a reviewable, committed spec.
 *
 * The output is **committed**, and that is the point. A spec decides which paths
 * get called with the operator's token, and `connect` grants everything a
 * provider discovers — so a spec fetched at connect time from a third party
 * could introduce, say, a DELETE operation that lands on the vendor's own host
 * holding a real credential. Vendoring makes the surface reviewable and the
 * build reproducible; a per-provider script exists so refreshing it is one
 * command rather than a hand edit.
 *
 * Every caller passes its own `outputDirectory`, its own note strings, and opts
 * in to the repairs its upstream document happens to need. Nothing here knows
 * which vendor it is trimming: a document that declares path parameters one
 * level up is a shape, not a brand, and the flag that fixes it is set by the
 * provider that has that shape.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenAPIToolGenerator, type McpOpenAPITool } from 'mcp-from-openapi';
import { cutCycles, makeOpaque, referenced, type Spec } from './openapi.ts';
import {
  METHODS,
  dropSystemParameters,
  hoistParameters,
  narrowRequestBody,
} from './vendor-operations.ts';

/** Kept in step with `BUDGET_KB` in `src/cli/tools.test.ts`, which enforces it. */
export const BUDGET_KB = 64;

export interface VendorSpecOptions {
  /** The upstream document. */
  readonly source: string;
  /**
   * Where to write, which is the caller's own `import.meta.dir`.
   *
   * A parameter rather than this module's own directory, and not a stylistic
   * choice: resolving it here would write every provider's spec into
   * `providers/shared/`, report success, and leave the committed file untouched.
   * That exact no-op shipped once before — see the note in the Google script.
   */
  readonly outputDirectory: string;
  readonly out: string;
  /** The operations to keep, by `operationId`. Everything else is dropped. */
  readonly operations: readonly string[];
  /** Schemas to replace with an open object, before reachability is computed. */
  readonly opaque?: readonly string[];
  /** The sentence `makeOpaque` appends, naming where the real shape is documented. */
  readonly opaqueNote?: string;
  /** What `info['x-vendored-note']` records about why this file is committed. */
  readonly vendoredNote: string;
  /** Vendor-specific query parameters to strip from every operation. */
  readonly systemParameters?: ReadonlySet<string>;
  /**
   * Move path-item `parameters` onto each operation, and delete the shared copy.
   *
   * Off by default, because a document that already declares its parameters per
   * operation must not be rewritten — and a path-item `parameters` array is also
   * where some vendors put the query parameters shared by every method on the
   * path, which the operations genuinely need to inherit rather than own.
   *
   * On, it repairs a document whose path parameters live only at the path level.
   * `mcp-from-openapi`'s validator reads `operation.parameters` and nothing else,
   * so such a document fails validation outright with one
   * `MISSING_PATH_PARAMETER` per parameter and generates zero tools. Deleting the
   * shared copy is half the fix: leaving both makes the generator see the same
   * parameter twice and rename one of them.
   */
  readonly hoistPathParameters?: boolean;
  /**
   * Request body content types to keep. Omit to keep all of them.
   *
   * The HTTP connector encodes a body as JSON or form-urlencoded, whichever the
   * document declares (ADR-045). It cannot do `multipart/form-data` at all — a
   * multipart branch would be JSON-stringified under a multipart content type —
   * so that branch describes a request it cannot make, and carries the cost of
   * one anyway.
   *
   * Worse than dead weight: multipart file fields are named `files[0]`, which is
   * not a legal tool property name, and one illegal name rejects the *entire*
   * tools list for every provider on the endpoint. Nothing but the generator's
   * own content-type preference order keeps it out of the generated schema, and
   * that is a third party's choice to change.
   */
  readonly requestContentTypes?: readonly string[];
  /**
   * Replace an operation's whole request body schema, by `operationId`.
   *
   * For a body the generator cannot flatten. A top-level `anyOf` has no
   * `properties` to walk, so it emits a single argument literally named `body`
   * and the connector then sends `{"body":{…}}` where the vendor expects
   * `{…}` — every test in the repository passes and only a live call fails.
   * Naming the branch that is actually wanted flattens it back out.
   *
   * Applied before reachability, so a branch that is no longer referenced leaves
   * the document rather than lingering unused.
   */
  readonly rewriteRequestBody?: Readonly<Record<string, unknown>>;
}

export async function vendorSpec(id: string, options: VendorSpecOptions): Promise<void> {
  const { source, operations } = options;
  const wanted = new Set(operations);

  const response = await fetch(source);
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  const spec = (await response.json()) as Spec;

  const paths: Spec['paths'] = {};
  const seen = new Set<string>();

  for (const [path, item] of Object.entries(spec.paths)) {
    const kept: Record<string, unknown> = {};
    for (const [method, operation] of Object.entries(item)) {
      // Path-level keys are not operations and must survive: `parameters` here
      // is where some vendors put the query parameters shared by every method on
      // the path, and one of those may be *required* by an operation. Dropping
      // it produced a tool with no arguments at all and a 400 on every call.
      if (!METHODS.includes(method)) {
        kept[method] = operation;
        continue;
      }
      const operationId = operation.operationId;
      if (!operationId || !wanted.has(operationId)) continue;
      kept[method] = operation;
      seen.add(operationId);
    }

    // Only path-level keys survived, so no operation here was wanted.
    if (!Object.keys(kept).some((key) => METHODS.includes(key))) continue;
    if (Object.keys(kept).length > 0) paths[path] = kept as Spec['paths'][string];
  }

  const componentParameters = (spec.components?.['parameters'] ?? {}) as Record<string, unknown>;
  const system = options.systemParameters ?? new Set<string>();

  let hoisted = 0;
  if (options.hoistPathParameters) {
    for (const item of Object.values(paths)) {
      hoisted += hoistParameters(item as unknown as Record<string, unknown>, componentParameters);
    }
  }

  let dropped = 0;
  for (const item of Object.values(paths)) {
    dropped += dropSystemParameters(
      item as unknown as Record<string, unknown>,
      componentParameters,
      system,
    );
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.includes(method)) continue;
      dropped += dropSystemParameters(
        operation as unknown as Record<string, unknown>,
        componentParameters,
        system,
      );
    }
  }

  let narrowed = 0;
  for (const item of Object.values(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.includes(method)) continue;
      const holder = operation as unknown as Record<string, unknown>;

      if (options.requestContentTypes) {
        narrowed += narrowRequestBody(
          holder,
          operation.operationId ?? `${method} path`,
          options.requestContentTypes,
        );
      }

      const replacement = operation.operationId
        ? options.rewriteRequestBody?.[operation.operationId]
        : undefined;
      if (replacement) {
        const body = holder['requestBody'] as { content?: Record<string, unknown> } | undefined;
        for (const type of Object.keys(body?.content ?? {})) {
          (body!.content![type] as Record<string, unknown>)['schema'] = replacement;
        }
      }
    }
  }

  // Drop response schemas.
  //
  // Two reasons, and the second is the blocking one. Nothing reads them: the
  // connector hands the response body back as text, because an agent wants the
  // JSON, not a validated shape. And a recursive response schema — a message
  // whose payload is a part, which contains parts — sends the OpenAPI tool
  // generator into infinite recursion and silently drops operations from the
  // tool list.
  for (const item of Object.values(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.includes(method)) continue;
      (operation as { responses?: unknown }).responses = {
        '200': { description: 'Success. The response body is returned verbatim.' },
      };
    }
  }

  const missing = operations.filter((operationId) => !seen.has(operationId));
  if (missing.length > 0) {
    // Loudly, rather than shipping a provider quietly missing capabilities: an
    // upstream rename should fail the refresh, not shrink the tool list.
    throw new Error(`${id}: these operations are not in the spec — ${missing.join(', ')}`);
  }

  const schemas = spec.components?.schemas ?? {};
  const opaqued = makeOpaque(schemas, options.opaque ?? [], options.opaqueNote ?? '');
  const keep = referenced(paths, schemas);
  const trimmedSchemas = Object.fromEntries(
    Object.entries(schemas).filter(([name]) => keep.has(name)),
  );
  const cuts = cutCycles(trimmedSchemas);

  const trimmed: Spec = {
    openapi: spec.openapi,
    info: {
      ...spec.info,
      'x-vendored-from': source,
      'x-vendored-note': options.vendoredNote,
    },
    ...(spec.servers ? { servers: spec.servers } : {}),
    paths,
    components: { ...spec.components, schemas: trimmedSchemas },
  };

  await mkdir(options.outputDirectory, { recursive: true });
  await writeFile(
    join(options.outputDirectory, options.out),
    `${JSON.stringify(trimmed, null, 2)}\n`,
  );

  const size = Math.round(JSON.stringify(trimmed).length / 1024);
  const extra = [
    options.hoistPathParameters ? `${hoisted} params hoisted` : '',
    narrowed > 0 ? `${narrowed} body types dropped` : '',
  ].filter(Boolean);
  console.log(
    `  ${id.padEnd(6)} ${String(Object.keys(paths).length).padStart(2)} paths, ` +
      `${seen.size} operations, ${Object.keys(trimmedSchemas).length} schemas, ` +
      `${cuts} cycle${cuts === 1 ? '' : 's'} cut, ${opaqued} made opaque, ` +
      `${dropped} system params dropped, ${size}KB` +
      (extra.length > 0 ? `, ${extra.join(', ')}` : ''),
  );

  await reportLargestTools(id, trimmed, seen.size);
}

/**
 * The number the budget is actually about, and a count that proves nothing fell out.
 *
 * Everything on the line above counts the *spec*; `cli/tools.test.ts` measures
 * the **generated input schema**, and the two differ by orders of magnitude
 * because `mcp-from-openapi` inlines `$ref`s — a schema shared by ten fields is
 * ten copies once generated. Reasoning about one operation from a schema count
 * put it at 122 KB when the real figure was 1,133 KB, which is the whole
 * difference between "just over" and "seventeen times over".
 *
 * Printed here so the refresh that adds an operation shows its cost, rather than
 * leaving it to a test failure to say so after the fact.
 *
 * The count is the other half. The generator answers an unresolvable reference by
 * logging to the console and omitting that one tool, so a document can trim
 * cleanly, write successfully, and quietly advertise less than it selected.
 * `tools.test.ts` only asserts the surface is non-empty, so nothing downstream
 * would notice.
 */
async function reportLargestTools(id: string, trimmed: Spec, expected: number): Promise<void> {
  let measured: Array<{ name: string; kb: number }>;

  try {
    const generator = await OpenAPIToolGenerator.fromJSON(trimmed);
    const tools = await generator.generateTools();

    if (tools.length !== expected) {
      throw new Error(
        `${id}: the spec holds ${expected} operations but only ${tools.length} generated. ` +
          'The generator omits a tool it cannot resolve — check for a dangling $ref, ' +
          'including into components this script trimmed.',
      );
    }

    measured = tools
      .map((tool: McpOpenAPITool) => ({
        name: tool.metadata.operationId ?? tool.name,
        kb: JSON.stringify(tool.inputSchema).length / 1024,
      }))
      .sort((a, b) => b.kb - a.kb);
  } catch (error) {
    // A count mismatch is this script's to report — it is the one failure
    // `tools.test.ts` cannot see. A generator failure is not: that shows up
    // against every provider at once, and refusing to finish over it would
    // leave the specs half-written.
    if (error instanceof Error && error.message.startsWith(`${id}: the spec holds`)) throw error;
    console.log(`         (could not measure generated schemas: ${String(error)})`);
    return;
  }

  for (const { name, kb } of measured.slice(0, 3)) {
    const over = kb > BUDGET_KB ? `  ✗ over the ${BUDGET_KB}KB budget` : '';
    console.log(`         ${name.padEnd(38)} ${kb.toFixed(1).padStart(8)}KB${over}`);
  }
}
