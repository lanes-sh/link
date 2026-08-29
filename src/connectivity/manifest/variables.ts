import { z } from 'zod';
import { identifier } from './primitives.ts';

/**
 * Where a service lives, when that is a property of the connection rather than
 * of the provider.
 *
 * `base_url`, `endpoint` and `host` are one value per manifest, which is right
 * for a vendor that runs one address for everybody — Gmail is
 * `gmail.googleapis.com` for every account there has ever been. It is wrong for
 * two large families:
 *
 *   - **multi-tenant SaaS whose host carries the tenant** — Zendesk is
 *     `<subdomain>.zendesk.com`, Shopify `<shop>.myshopify.com`, Atlassian
 *     `api.atlassian.com/ex/jira/<cloudid>`
 *   - **anything self-hosted** — a Nextcloud, a Gitea, a Home Assistant, each at
 *     an address only its owner knows
 *
 * Both were reachable already, but only by hand-writing a YAML manifest per
 * instance in `providers.d/`. What was impossible was a *built-in* for any of
 * them, because a built-in cannot know the address. A declared variable is the
 * missing half: the manifest says a placeholder is there and what fills it, and
 * the connection supplies the value.
 *
 * Deliberately not a credential. A hostname is not a secret and does not belong
 * in the secret store; it lives in the connection's own `config`, which is what
 * that field has always been for.
 */

/**
 * What a value is allowed to be, and the reason this is not cosmetic.
 *
 * A variable is substituted into a URL, so an unconstrained value chooses the
 * host the operator's credential is sent to: `acme.zendesk.com/../..@evil.test`
 * in a `{site}` would leave a manifest that reads as Zendesk and authenticates
 * to somebody else. This is the check that stops that, and it runs at
 * *substitution* rather than only at the prompt — config is a file that can be
 * edited by hand, and a deployed revision reads it without ever seeing a prompt.
 *
 * One DNS label or path segment: letters, digits, and the three separators that
 * appear inside real subdomains and tenant ids. No dots by default, because a
 * dot is how you leave the domain the manifest named; a provider whose value
 * genuinely contains one says so with its own `pattern`.
 */
export const DEFAULT_VARIABLE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]*$';

export const connectionVariableSchema = z.object({
  /** The name inside the braces. `{site}` is `key: 'site'`. */
  key: identifier,
  /** What to call it when asking, in the vendor's own word — "subdomain", not "variable". */
  label: z.string().min(1),
  /** One line: what it is and where the operator finds it. */
  description: z.string().min(1),
  /** A real-looking value, shown in the prompt and in the refusal. */
  example: z.string().min(1),
  /**
   * Override the default only to *narrow* it or to admit a character the
   * default excludes — a cloud id with dots, a path segment with slashes. A
   * pattern that admits `/` or `@` is choosing to trust the value with the host,
   * and should say why.
   */
  pattern: z
    .string()
    .default(DEFAULT_VARIABLE_PATTERN)
    // Anchored here rather than trusted to be anchored, and compiled here
    // rather than at the first call.
    //
    // `test` matches a substring, so an unanchored pattern silently voids the
    // guarantee this field exists for: `[a-z.]+` accepts `acme.evil.test/@x`,
    // which is then substituted into the URL the operator's credential is sent
    // to. Both built-ins anchor; a manifest in `providers.d/` is not obliged to
    // read this file first, and a security control that depends on remembering
    // is not one.
    //
    // Wrapped rather than refused, because what an author means by a pattern is
    // always "the value looks like this" — nobody writes one intending a
    // substring match. An invalid regex is refused, though, and refused at load
    // rather than surfacing as a raw SyntaxError when a connector is built.
    .transform((pattern) => (/^\^.*\$$/.test(pattern) ? pattern : `^(?:${pattern})$`))
    .superRefine((pattern, context) => {
      try {
        new RegExp(pattern);
      } catch (failure) {
        context.addIssue({
          code: 'custom',
          message: `is not a usable regular expression: ${(failure as Error).message}`,
        });
      }
    }),
});

export type ConnectionVariable = z.infer<typeof connectionVariableSchema>;

/** Every `{name}` in a string, in the order they appear, without duplicates. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((match) => match[1]!))];
}

/**
 * Every placeholder anywhere in a connector, however deep.
 *
 * A field list was the first shape and it was wrong within one provider: the
 * `imap` connector's submission host is `smtp.host`, a level down, so a generic
 * mailbox declaring `{smtp_host}` was refused for using a variable that
 * "appears in no address". Walking the object has no list to keep in step with
 * a transport schema, and a `{name}` in a field where it means nothing is
 * simply never substituted rather than silently wrong.
 */
export function placeholdersInConnector(connector: Record<string, unknown>): string[] {
  const found = new Set<string>();

  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const name of placeholdersIn(node)) found.add(name);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const value of Object.values(node as Record<string, unknown>)) walk(value);
  };

  walk(connector);
  return [...found];
}

/**
 * Fill a connector's address in, or say exactly what is wrong.
 *
 * Returns the connector untouched when it declares no variables, which is every
 * provider but a handful — so this costs nothing where it is not used and cannot
 * quietly reshape a connector that was already complete.
 */
export function applyVariables(
  connector: Record<string, unknown>,
  variables: readonly ConnectionVariable[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (variables.length === 0) return connector;

  const resolved = new Map<string, string>();
  for (const variable of variables) {
    const value = values[variable.key];
    if (typeof value !== 'string' || value === '') {
      throw new Error(
        `This connection does not say what "${variable.key}" is (${variable.label}). ` +
          `Reconnect it, or add it under this connection's config: ${variable.key}: ${variable.example}`,
      );
    }
    if (!new RegExp(variable.pattern).test(value)) {
      throw new Error(
        `"${value}" is not a usable ${variable.label} — it must match ${variable.pattern}, ` +
          `like ${variable.example}. The value is put into the address this connection calls, ` +
          `so anything that could change the host is refused rather than sent.`,
      );
    }
    resolved.set(variable.key, value);
  }

  const substitute = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) =>
        resolved.get(name) ?? whole,
      );
    }
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(substitute);

    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, value]) => [key, substitute(value)]),
    );
  };

  return substitute(connector) as Record<string, unknown>;
}
