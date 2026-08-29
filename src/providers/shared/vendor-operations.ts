/**
 * Document surgery on path items and operations.
 *
 * The other axis from `vendor-schemas.ts`: that file rewrites the schemas map,
 * this one rewrites what an operation declares it takes — its parameters and the
 * content types its request body offers. Both exist because the generated tool,
 * not the document, is what has to be correct and small.
 */

export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];

/** The name a parameter goes by, resolving a `$ref` into `components.parameters`. */
export function parameterName(
  parameter: unknown,
  components: Record<string, unknown>,
): string | undefined {
  const record = parameter as { name?: string; $ref?: string };
  if (record.name) return record.name;
  if (!record.$ref) return undefined;

  // The component *key* is not the parameter name — `$.xgafv` is keyed
  // `_.xgafv`, because a `$` is awkward in a JSON pointer. Matching on the key
  // would therefore miss exactly the one that breaks everything.
  const key = record.$ref.replace('#/components/parameters/', '');
  return (components[key] as { name?: string } | undefined)?.name;
}

/** Strip vendor system parameters from a path item or an operation. */
export function dropSystemParameters(
  holder: Record<string, unknown>,
  components: Record<string, unknown>,
  system: ReadonlySet<string>,
): number {
  const parameters = holder['parameters'];
  if (!Array.isArray(parameters)) return 0;

  const kept = parameters.filter((parameter) => {
    const name = parameterName(parameter, components);
    return !(name && system.has(name));
  });

  holder['parameters'] = kept;
  return parameters.length - kept.length;
}

/** Move a path item's shared `parameters` onto each of its operations. */
export function hoistParameters(
  item: Record<string, unknown>,
  components: Record<string, unknown>,
): number {
  const shared = item['parameters'];
  if (!Array.isArray(shared) || shared.length === 0) return 0;

  let moved = 0;
  for (const [method, operation] of Object.entries(item)) {
    if (!METHODS.includes(method)) continue;

    const holder = operation as Record<string, unknown>;
    const own = Array.isArray(holder['parameters']) ? (holder['parameters'] as unknown[]) : [];
    const taken = new Set(
      own.map((parameter) => parameterName(parameter, components)).filter(Boolean),
    );

    // An operation that already declares the parameter keeps its own. Adding
    // both is what produces a renamed duplicate.
    const inherited = shared.filter(
      (parameter) => !taken.has(parameterName(parameter, components)),
    );
    holder['parameters'] = [...inherited, ...own];
    moved += inherited.length;
  }

  delete item['parameters'];
  return moved;
}

/** Keep only the listed request body content types, refusing to empty a body. */
export function narrowRequestBody(
  operation: Record<string, unknown>,
  operationId: string,
  allowed: readonly string[],
): number {
  const body = operation['requestBody'] as { content?: Record<string, unknown> } | undefined;
  if (!body?.content) return 0;

  const before = Object.keys(body.content);
  const kept = before.filter((type) => allowed.includes(type));
  if (kept.length === 0) {
    // Silently leaving the body alone would reintroduce whatever the filter was
    // added to remove, so this is a refusal rather than a fallback.
    throw new Error(
      `${operationId}: request body offers ${before.join(', ')}, none of which is kept by requestContentTypes (${allowed.join(', ')}).`,
    );
  }

  body.content = Object.fromEntries(kept.map((type) => [type, body.content![type]]));
  return before.length - kept.length;
}

/**
 * Replace a request body with a projection of the schema it points at.
 *
 * The third surgery on this axis, and the first about the body being *wrong*
 * rather than too wide. A document that describes two operations with one schema
 * describes at least one of them wrongly, and `required` is where it bites: the
 * generated tool asks for arguments the vendor refuses on the call they are
 * attached to, so there is no correct call to make. It fails at the vendor, on
 * every attempt, and nothing before the request can see it.
 *
 * Projecting rather than hand-writing is what keeps this tied to the document.
 * The named fields are copied out of the vendor's own schema with their types
 * and descriptions, so the tool still says what the vendor says. Everything this
 * cannot verify it refuses instead: a field that is gone, a field the document
 * marks read-only, a body offering a content type this does not rewrite, a
 * `$ref` that does not point into `components.schemas`. A vendor refresh should
 * fail loudly here rather than quietly restore the body it was called to fix.
 *
 * `required` is the one thing NOT projected — it is the caller's assertion, and
 * necessarily so, since the whole disease is a `required` written for the other
 * operation. Say why in the caller.
 *
 * `note` becomes the body schema's description. It lands in the committed
 * document for whoever reads it there; it does **not** reach the agent, because
 * the generator flattens body properties to the top level and drops the body
 * schema's own description. The sentence an agent needs goes in `hints`.
 *
 * Apply before reachability, so a schema the projection no longer reaches leaves
 * the document rather than lingering unused.
 */
/**
 * Every property a schema describes, including the ones it inherits.
 *
 * OpenAPI spells inheritance `allOf: [{ $ref: parent }, { properties: … }]`, and
 * a schema written that way has no `properties` of its own at the top level.
 * Microsoft Graph uses it for every entity: `microsoft.graph.message` declares
 * thirty-one properties and inherits `categories` from `outlookItem`, so reading
 * `properties` off the schema alone reports a field the vendor plainly does
 * describe as missing — and the refusal that exists to catch a rename fires on a
 * document that never changed.
 *
 * Nearest definition wins, which is what `allOf` means: a later member overrides
 * an earlier one, and the schema's own `properties` override everything it
 * inherits. `seen` is against a cycle in the inheritance chain rather than in the
 * data — `cutCycles` handles the other kind, and this walk would not reach it.
 */
function describedProperties(
  schema: unknown,
  schemas: Record<string, unknown>,
  seen: Set<string> = new Set(),
): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object') return {};
  const record = schema as Record<string, unknown>;

  const reference = record['$ref'];
  if (typeof reference === 'string') {
    if (!reference.startsWith('#/components/schemas/')) return {};
    const name = reference.slice('#/components/schemas/'.length);
    if (seen.has(name)) return {};
    seen.add(name);
    return describedProperties(schemas[name], schemas, seen);
  }

  const collected: Record<string, unknown> = {};
  for (const member of (record['allOf'] as unknown[] | undefined) ?? []) {
    Object.assign(collected, describedProperties(member, schemas, seen));
  }
  Object.assign(collected, (record['properties'] as Record<string, unknown> | undefined) ?? {});

  return collected;
}

export function projectRequestBody(
  operation: Record<string, unknown>,
  operationId: string,
  schemas: Record<string, unknown>,
  fields: readonly string[],
  note: string,
): void {
  const content = (operation['requestBody'] as { content?: Record<string, { schema?: { $ref?: string } }> })
    ?.content;
  const types = Object.keys(content ?? {});

  const other = types.filter((type) => type !== 'application/json');
  if (!content || types.length === 0 || other.length > 0) {
    // A body left pointing at the wide schema on a second content type is the
    // bug still present on whichever branch the generator happens to prefer.
    throw new Error(
      `${operationId}: expected a lone application/json request body to project, found ${types.join(', ') || 'none'}`,
    );
  }

  const json = content['application/json'];
  const reference = json?.schema?.$ref;
  if (!json || typeof reference !== 'string' || !reference.startsWith('#/components/schemas/')) {
    throw new Error(`${operationId}: request body is ${reference ?? 'not a $ref'}, not a schema reference`);
  }

  const name = reference.slice('#/components/schemas/'.length);
  const source = describedProperties(schemas[name], schemas);

  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    const property = source[field] as { readOnly?: boolean } | undefined;
    if (!property) throw new Error(`${operationId}: ${name} no longer describes "${field}"`);
    if (property.readOnly === true) {
      // Projected fields are inlined into the path, where the read-only strip
      // does not reach — so a field the vendor computes would survive here and
      // be demanded as an argument it ignores.
      throw new Error(`${operationId}: ${name}.${field} is read-only and cannot be a request field`);
    }
    properties[field] = property;
  }

  json.schema = {
    type: 'object',
    description: note,
    properties,
    required: [...fields],
  } as never;
}

