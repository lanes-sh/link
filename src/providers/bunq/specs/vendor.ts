/**
 * Vendor a trimmed OpenAPI spec for bunq.
 *
 * The output is **committed**, for the reason the Google script gives and then
 * some: a spec decides which paths get called with the operator's credential,
 * and this credential moves money. `connect` grants everything a provider
 * discovers, so the reviewable surface has to be a file in the repository
 * rather than a document fetched from GitHub at connect time.
 *
 * bunq's published spec cannot be used as it stands, and not marginally. It is
 * 1.37 MB across 271 paths, and generating tools from it fails on **55
 * operations with `Maximum call stack size exceeded`** — including every single
 * payment endpoint, because `Payment` recurses through `RequestInquiry` and
 * `RequestResponse` and `mcp-from-openapi` inlines `$ref`s. `cutCycles` is what
 * makes this provider possible at all; without it there is nothing here worth
 * shipping.
 *
 *   bun run vendor:bunq
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenAPIToolGenerator, type McpOpenAPITool } from 'mcp-from-openapi';
import { cutCycles, referenced, type Spec } from '../../shared/openapi.ts';

const SOURCE = 'https://raw.githubusercontent.com/bunq/doc/master/swagger.json';
const OUT = 'bunq.v1.json';

/** Kept in step with `BUDGET_KB` in `src/cli/tools.test.ts`, which enforces it. */
const BUDGET_KB = 64;

/**
 * Everything this provider can reach, and nothing else.
 *
 * The list *is* the security boundary, ahead of policy and ahead of the
 * connection's bundles: an operation absent here has no tool, so no rule can
 * allow it and no agent can find it. Adding a line is the decision worth
 * arguing about, which is why each one says why it is here.
 *
 * Reading: what an agent needs to know before it can pay anything — which
 * accounts exist, what is in them, and what has already gone out.
 *
 * Writing: the three shapes bunq offers for sending money. `Payment` executes
 * immediately. `DraftPayment` does not — it waits for approval in the bunq app,
 * which is the human checkpoint, and `UPDATE_DraftPayment` is how one is
 * cancelled or accepted. `PaymentBatch` is up to 350 payments in one call,
 * which is the whole point of automating a payment run rather than a payment.
 */
const OPERATIONS = [
  // Read. `List_all_User` first because every other path is addressed under a
  // userID, and nothing reports it but this.
  'List_all_User',
  'List_all_MonetaryAccount_for_User',
  'List_all_Payment_for_User_MonetaryAccount',
  'READ_Payment_for_User_MonetaryAccount',
  'List_all_DraftPayment_for_User_MonetaryAccount',
  'READ_DraftPayment_for_User_MonetaryAccount',
  'List_all_PaymentBatch_for_User_MonetaryAccount',
  // Write.
  'CREATE_Payment_for_User_MonetaryAccount',
  'CREATE_DraftPayment_for_User_MonetaryAccount',
  'UPDATE_DraftPayment_for_User_MonetaryAccount',
  'CREATE_PaymentBatch_for_User_MonetaryAccount',
  //
  // Not vendored, deliberately:
  //
  // `CREATE_RequestInquiry_*` — 355 KB generated, 5.5x the per-tool budget on
  // its own, and it asks *for* money rather than sending it. Neither half of
  // that is worth solving for a capability nobody asked for.
  //
  // `schedule-payment` and `schedule` — recurring payments. They fail cycle
  // cutting as well, and a standing order that an agent can create is a
  // different risk from a payment it can make: one is a decision taken once,
  // the other repeats without anybody looking. The bunq app does this well.
  //
  // Every `monetary-account-*` creation path — opening and closing accounts is
  // not paying bills, and `CREATE_MonetaryAccountBank` is a 15 KB body whose
  // only purpose here would be to widen what a compromised session can do.
  //
  // `card-*` — ordering and freezing cards, same argument.
] as const;

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];

/**
 * Drop every referenced parameter, which for bunq means every protocol header.
 *
 * bunq declares seven headers on almost every operation — `Cache-Control`,
 * `User-Agent`, `X-Bunq-Language`, `X-Bunq-Region`, `X-Bunq-Geolocation`,
 * `X-Bunq-Client-Request-Id` and `X-Bunq-Client-Authentication` — and the
 * generator turns each into a tool argument. That is wrong twice over. They are
 * noise on every schema, and the last one is the **session token**: leaving it
 * as an argument invites a model to fill it in, and means a tool call could
 * carry a credential the strategy is supposed to own.
 *
 * Every parameter bunq puts in `components.parameters` is one of these, so
 * dropping referenced parameters wholesale is exact rather than a heuristic —
 * the path parameters that must survive are declared inline. Google's script
 * needs a name list for the same job because Google mixes the two.
 */
function dropProtocolParameters(item: Record<string, unknown>): number {
  let dropped = 0;

  const filter = (holder: Record<string, unknown>): void => {
    const parameters = holder['parameters'];
    if (!Array.isArray(parameters)) return;

    const kept = parameters.filter((parameter) => {
      const reference = (parameter as { $ref?: string }).$ref;
      if (typeof reference !== 'string' || !reference.startsWith('#/components/parameters/')) {
        return true;
      }
      dropped++;
      return false;
    });

    if (kept.length > 0) holder['parameters'] = kept;
    else delete holder['parameters'];
  };

  filter(item);
  for (const [method, operation] of Object.entries(item)) {
    if (!METHODS.includes(method)) continue;
    filter(operation as Record<string, unknown>);
  }

  return dropped;
}

/**
 * Strip the properties OpenAPI already marks as response-only.
 *
 * bunq describes a request body by pointing at the *whole* resource, so the
 * body schema for creating a payment carries `id`, `created`, `updated`,
 * `balance_after_mutation` and two dozen more — fields bunq computes and
 * ignores on the way in. The document says so itself: they carry
 * `readOnly: true`, which the specification defines as "MAY be sent as part of
 * a response and SHOULD NOT be sent as part of the request".
 *
 * So this is the document's own judgement applied rather than ours invented,
 * which is the difference between this and a hand-written field list that would
 * go stale. It is safe only because responses have already been replaced above:
 * these schemas are now reachable from request bodies alone.
 *
 * **A schema left with nothing is opened rather than emptied.** Nine of bunq's
 * are, `LabelMonetaryAccount` among them — and that one is `counterparty_alias`
 * on a payment, which is to say the single field that decides who gets the
 * money. Every property of it is marked read-only because the document points
 * the *request* at the response type; what a payment actually takes there is a
 * `Pointer`, `{ type, value, name }`, as bunq's own guide says and as this
 * provider's `hints` repeat. Neither shape is worth asserting from here. What
 * matters is the difference between `{}` — which reads as "this field takes
 * nothing", and is the one thing that is certainly false — and an open object,
 * which reads as "send what the description says".
 */
function dropReadOnly(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0;
  if (Array.isArray(node)) return node.reduce<number>((total, item) => total + dropReadOnly(item), 0);

  let dropped = 0;
  const record = node as Record<string, unknown>;
  const properties = record['properties'];

  if (properties && typeof properties === 'object') {
    const fields = properties as Record<string, unknown>;
    const writable = Object.entries(fields).filter(
      ([, schema]) => (schema as { readOnly?: boolean })?.readOnly !== true,
    );

    if (writable.length === 0 && Object.keys(fields).length > 0) {
      delete record['properties'];
      record['additionalProperties'] = true;
      record['description'] =
        `${record['description'] ?? ''} Every field bunq documents here is read-only, so its request shape is not described by the specification — send the object the tool description names.`.trim();
      return dropped;
    }

    for (const [name, schema] of Object.entries(fields)) {
      if ((schema as { readOnly?: boolean })?.readOnly === true) {
        delete fields[name];
        dropped++;
      }
    }
  }

  for (const value of Object.values(record)) dropped += dropReadOnly(value);
  return dropped;
}


async function vendor(): Promise<void> {
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`${SOURCE}: HTTP ${response.status}`);
  const spec = (await response.json()) as Spec;

  const wanted = new Set<string>(OPERATIONS);
  const paths: Spec['paths'] = {};
  const seen = new Set<string>();

  for (const [path, item] of Object.entries(spec.paths)) {
    const kept: Record<string, unknown> = {};

    for (const [method, operation] of Object.entries(item)) {
      // Path-level keys are not operations and must survive — `parameters`
      // here holds what every method on the path shares.
      if (!METHODS.includes(method)) {
        kept[method] = operation;
        continue;
      }
      const operationId = operation.operationId;
      if (!operationId || !wanted.has(operationId)) continue;
      kept[method] = operation;
      seen.add(operationId);
    }

    if (!Object.keys(kept).some((key) => METHODS.includes(key))) continue;
    paths[path] = kept as Spec['paths'][string];
  }

  // Drop response schemas, before `referenced` so nothing they reach is kept.
  //
  // The same two reasons as Google's, in the same order of importance. Nothing
  // reads them — the connector hands the body back as text. And bunq's response
  // schemas are where most of the recursion lives, so keeping them would drag
  // the whole `Payment`/`RequestInquiry` cycle into a document that does not
  // otherwise need it.
  for (const item of Object.values(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.includes(method)) continue;
      (operation as { responses?: unknown }).responses = {
        '200': { description: 'Success. The response body is returned verbatim.' },
      };
    }
  }

  let headers = 0;
  for (const item of Object.values(paths)) {
    headers += dropProtocolParameters(item as unknown as Record<string, unknown>);
  }

  const missing = OPERATIONS.filter((operationId) => !seen.has(operationId));
  if (missing.length > 0) {
    // Loudly: an upstream rename should fail the refresh rather than quietly
    // shrinking what this provider can do.
    throw new Error(`these operations are not in the spec — ${missing.join(', ')}`);
  }

  const schemas = spec.components?.schemas ?? {};
  const keep = referenced(paths, schemas);
  const trimmedSchemas = Object.fromEntries(
    Object.entries(schemas).filter(([name]) => keep.has(name)),
  );
  const cuts = cutCycles(trimmedSchemas);
  const readOnly = dropReadOnly(trimmedSchemas);

  const trimmed: Spec = {
    openapi: spec.openapi,
    info: {
      ...spec.info,
      // Replaced, not carried. bunq's own `description` is 73 KB of product
      // tour — 78% of what this file would otherwise weigh — and it is
      // documentation of the bank rather than of the API. It also carries
      // example addresses at bunq's own registrable domain, which
      // `architecture.test.ts` refuses anywhere a reader of this repository can
      // see. Both problems are the same field, and dropping it is better than
      // exempting the file: an exemption would also cover whatever the next
      // refresh brings in.
      description:
        'Trimmed from the published bunq specification. See x-vendored-from for the original, and https://doc.bunq.com for the reference.',
      'x-vendored-from': SOURCE,
      'x-vendored-note':
        'Trimmed by src/providers/bunq/specs/vendor.ts. Committed deliberately: a spec decides which paths are called with the operator credential, and this one can move money.',
    },
    // Rewritten rather than carried over. bunq's document declares both the
    // sandbox and production servers with a templated `{basePath}`, and the
    // manifest names one concrete `base_url` — leaving two in the spec invites
    // a reader to think the choice is made here. It is made by the strategy.
    servers: [{ url: 'https://api.bunq.com/v1' }],
    paths,
    components: { ...spec.components, schemas: trimmedSchemas },
  };

  const directory = import.meta.dir;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, OUT), `${JSON.stringify(trimmed, null, 2)}\n`);

  const size = Math.round(JSON.stringify(trimmed).length / 1024);
  console.log(
    `  bunq   ${String(Object.keys(paths).length).padStart(2)} paths, ` +
      `${seen.size} operations, ${Object.keys(trimmedSchemas).length} schemas, ` +
      `${cuts} cycle${cuts === 1 ? '' : 's'} cut, ${headers} protocol params dropped, ` +
      `${readOnly} read-only fields dropped, ${size}KB`,
  );

  await report(trimmed);
}

/**
 * What the budget is actually about: the **generated** input schema.
 *
 * Orders of magnitude away from the spec size on the line above, because
 * `$ref`s are inlined. Printed so a refresh that adds an operation shows what
 * it costs, rather than leaving `cli/tools.test.ts` to say so afterwards.
 */
async function report(trimmed: Spec): Promise<void> {
  try {
    const generator = await OpenAPIToolGenerator.fromJSON(trimmed);
    const tools = await generator.generateTools();

    const measured = tools
      .map((tool: McpOpenAPITool) => ({
        name: tool.metadata.operationId ?? tool.name,
        kb: JSON.stringify(tool.inputSchema).length / 1024,
      }))
      .sort((a, b) => b.kb - a.kb);

    for (const { name, kb } of measured.slice(0, 4)) {
      const over = kb > BUDGET_KB ? `  ✗ over the ${BUDGET_KB}KB budget` : '';
      console.log(`         ${name.padEnd(46)} ${kb.toFixed(1).padStart(7)}KB${over}`);
    }

    const surface = tools.reduce(
      (total, tool) => total + JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema }).length,
      0,
    );
    console.log(`         ${'whole advertised surface'.padEnd(46)} ${(surface / 1024).toFixed(1).padStart(7)}KB`);
  } catch (error) {
    console.log(`         (could not measure generated schemas: ${String(error)})`);
  }
}

await vendor();
