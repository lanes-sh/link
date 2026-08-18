/**
 * Making a discovered schema safe to publish.
 *
 * Two problems, both arriving from vendors rather than from us, and both fixed
 * here rather than per-provider so an upstream MCP server and a hand-written
 * workspace manifest get the same treatment as Google's specs.
 */

/**
 * Property names a tool schema may use.
 *
 * The Anthropic API enforces `^[a-zA-Z0-9_.-]{1,64}$` on every property key,
 * and rejects the **entire** `tools` array when one fails — so a single bad key
 * anywhere takes down every provider on the endpoint, not just its own. Google's
 * specs ship `$.xgafv`, which is exactly that.
 */
const LEGAL_PROPERTY = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * JSON Schema's own `format` values.
 *
 * Anything else is an OpenAPI or vendor annotation — `int64`, `uint64`,
 * `float`, `byte`, Google's `google` — and a validator that does not recognise
 * it logs a warning for every occurrence, every time a schema is compiled.
 * Google's specs carry six such formats, which is where "unknown format uint64
 * ignored" comes from.
 */
const STANDARD_FORMATS = new Set([
  'date-time', 'date', 'time', 'duration',
  'email', 'idn-email', 'hostname', 'idn-hostname',
  'ipv4', 'ipv6', 'uri', 'uri-reference', 'uri-template',
  'iri', 'iri-reference', 'uuid', 'regex',
  'json-pointer', 'relative-json-pointer',
]);

/**
 * **Illegal property names are dropped.** Dropping rather than renaming: the
 * name is what the connector maps back to a request parameter, so a renamed key
 * would arrive upstream as something the vendor does not recognise. A *required*
 * property is left in place, to fail loudly rather than register a tool that can
 * never be called correctly.
 *
 * **Non-standard `format` values are dropped.** They are annotations a JSON
 * Schema validator has no rule for; it ignores them and says so, once per
 * occurrence per compile. Removing them loses nothing — `type` still carries the
 * constraint that matters — and removes a stream of warnings that buries
 * anything worth reading.
 */
export function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;

    const record = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    const required = new Set((record['required'] as string[] | undefined) ?? []);

    for (const [key, value] of Object.entries(record)) {
      if (key === 'format' && typeof value === 'string' && !STANDARD_FORMATS.has(value)) continue;

      if (key === 'properties' && value !== null && typeof value === 'object') {
        out[key] = Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([name]) => LEGAL_PROPERTY.test(name) || required.has(name))
            .map(([name, child]) => [name, walk(child)]),
        );
        continue;
      }

      out[key] = walk(value);
    }

    return out;
  };

  return walk(schema) as Record<string, unknown>;
}
