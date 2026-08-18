import type { IdentityDeclaration, ProviderManifest } from '#connectivity';

/**
 * Working out whose account was just authorised.
 *
 * A connection list that reads `Gmail main`, `Gmail main2`, `Gmail main3`
 * cannot answer the one question it exists to answer. Worse, without an
 * identity there is no way to tell a *reconnect* from a *new account*, so
 * re-running `connect` after a failed attempt appends another row instead of
 * repairing the one already there — which is precisely how `main3` came to
 * exist.
 *
 * Everything here is best-effort. A provider that declares no identity, or
 * whose probe fails, falls back to asking the operator: a label is worth
 * having, never worth failing a connect over.
 */

/** Walk a dotted path, tolerating the first array element on the way. */
export function pluck(value: unknown, path: string): string | null {
  let current: unknown = value;

  for (const segment of path.split('.')) {
    if (Array.isArray(current)) current = current[0];
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }

  if (Array.isArray(current)) current = current[0];
  return typeof current === 'string' && current.length > 0 ? current : null;
}

export interface IdentityProbe {
  /** A valid upstream access token, if the provider authenticates. */
  readonly accessToken: () => Promise<string | null>;
  /** Call a capability on the upstream MCP server. */
  readonly callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Ask the connector, for a protocol whose identity is not a URL away. */
  readonly identify?: () => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
}

export async function resolveAccount(
  manifest: ProviderManifest,
  probe: IdentityProbe,
): Promise<string | null> {
  const identity: IdentityDeclaration | undefined = manifest.identity;
  if (!identity) return null;

  try {
    if (identity.kind === 'connector') {
      return (await probe.identify?.()) ?? null;
    }

    if (identity.kind === 'http') {
      const token = await probe.accessToken();
      const request = probe.fetch ?? globalThis.fetch;
      const response = await request(identity.url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) return null;
      return pluck(await response.json(), identity.field);
    }

    if (!probe.callTool) return null;
    const result = await probe.callTool(identity.tool, identity.arguments);

    // MCP results arrive as content blocks; the useful part is usually JSON in
    // a text block, so try that before falling back to the raw shape.
    const text = pluck(result, 'content.text');
    if (text) {
      try {
        return pluck(JSON.parse(text), identity.field) ?? text;
      } catch {
        return text;
      }
    }
    return pluck(result, identity.field);
  } catch {
    return null;
  }
}

/**
 * Turn an account into a connection id.
 *
 * `ada.lovelace@example.com` becomes `ada_lovelace`, which is what appears in
 * `credential_ref` and in the agent's `connection` argument. The local part is
 * enough to tell accounts apart in practice, and the full address is still
 * right there in `account` when it is not.
 */
export function idFromAccount(account: string, taken: readonly string[] = []): string {
  const local = account.includes('@') ? (account.split('@')[0] ?? account) : account;

  const base =
    local
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'main';

  if (!taken.includes(base)) return base;

  // A genuine collision — two accounts sharing a local part, e.g. the same
  // name at two domains. Suffixing beats overwriting someone else's credential.
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}
