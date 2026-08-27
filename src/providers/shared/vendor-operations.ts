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
