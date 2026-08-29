import type { ParameterMapper } from 'mcp-from-openapi';

/**
 * Property keys the Anthropic API will accept.
 *
 * It enforces `^[a-zA-Z0-9_.-]{1,64}$` on every key in a tool's input schema and
 * rejects **the whole `tools` array** when one fails — so a single argument named
 * `$top` takes down every provider on the endpoint at once, not just its own.
 * That has happened: Google's `$.xgafv` produced 107 tools, one 400, and nothing
 * working.
 *
 * Guarding it in the vendoring script was the first answer and it is the wrong
 * layer. A script only protects the specs it runs over, and the constraint
 * belongs to every `http` provider, including a YAML manifest in `providers.d/`
 * pointing at a document nobody here has read. Microsoft Graph makes that
 * concrete: OData names every query parameter `$top`, `$select`, `$filter`,
 * `$orderby`, and dropping them would leave an agent unable to ask for less than
 * a whole mailbox.
 *
 * So the key is renamed and the *wire name is not*. `ParameterMapper` already
 * carries the two separately — `inputKey` is what the caller passes, `key` is
 * what the request sends — and nothing but this function has ever needed them to
 * differ.
 */
export const LEGAL_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;

function legalKey(name: string, taken: ReadonlySet<string>): string {
  const stripped = name.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);
  // Everything illegal, or a name that was only its illegal characters.
  const base = stripped === '' ? 'argument' : stripped;

  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base.slice(0, 61)}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Rename what the caller passes, leaving what the request sends alone.
 *
 * Returns the schema unchanged when every key is already legal, which is every
 * provider but Microsoft today — so this costs nothing where it is not needed
 * and cannot quietly reshape a schema that was fine.
 */
export function withLegalKeys(
  schema: Record<string, unknown>,
  mapper: readonly ParameterMapper[],
): { schema: Record<string, unknown>; mapper: readonly ParameterMapper[] } {
  const properties = schema['properties'] as Record<string, unknown> | undefined;
  if (!properties) return { schema, mapper };

  const illegal = Object.keys(properties).filter((key) => !LEGAL_KEY.test(key));
  if (illegal.length === 0) return { schema, mapper };

  const taken = new Set(Object.keys(properties).filter((key) => LEGAL_KEY.test(key)));
  const renamed = new Map<string, string>();
  for (const key of illegal) {
    const legal = legalKey(key, taken);
    taken.add(legal);
    renamed.set(key, legal);
  }

  const nextProperties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    nextProperties[renamed.get(key) ?? key] = value;
  }

  const required = schema['required'];
  return {
    schema: {
      ...schema,
      properties: nextProperties,
      ...(Array.isArray(required)
        ? { required: required.map((key) => renamed.get(String(key)) ?? key) }
        : {}),
    },
    mapper: mapper.map((entry) =>
      renamed.has(entry.inputKey) ? { ...entry, inputKey: renamed.get(entry.inputKey)! } : entry,
    ),
  };
}

