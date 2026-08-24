import { describe, expect, test } from 'bun:test';
import { createHttpConnector } from '#connectivity/transports';
import { PROVIDER_MANIFESTS as PROVIDERS } from '#providers/index.ts';

/**
 * Every tool this endpoint can serve must be registrable.
 *
 * The Anthropic API enforces `^[a-zA-Z0-9_.-]{1,64}$` on property keys and
 * rejects the entire `tools` array when one fails — so a single bad key takes
 * down every provider at once. Google's specs ship `$.xgafv`, which did exactly
 * that: 107 tools, one 400, nothing worked.
 *
 * Checked against the vendored specs rather than a live endpoint, so a spec
 * refresh that reintroduces one fails here rather than in someone's agent.
 */

const LEGAL = /^[a-zA-Z0-9_.-]{1,64}$/;

const httpProviders = PROVIDERS.filter(
  (manifest) => manifest.connector.kind === 'http',
);

describe('vendored specs yield registrable tools', () => {
  test('there are http providers to check', () => {
    expect(httpProviders.length).toBeGreaterThan(0);
  });

  test.each(httpProviders.map((m) => [m.id, m] as const))('%s', async (_id, manifest) => {
    const connector = manifest.connector as { base_url: string; openapi: string };
    const capabilities = await createHttpConnector({
      baseUrl: connector.base_url,
      openapi: connector.openapi,
    }).discover({ manifest });

    expect(capabilities.length).toBeGreaterThan(0);

    for (const capability of capabilities) {
      const properties = (capability.inputSchema['properties'] ?? {}) as Record<string, unknown>;
      const illegal = Object.keys(properties).filter((name) => !LEGAL.test(name));

      expect(`${capability.name}: ${illegal.join(', ')}`).toBe(`${capability.name}: `);
    }
  });

  /**
   * The manifest's `base_url` has to agree with the spec's own server.
   *
   * A spec's paths are written relative to the server it declares, and the two
   * halves are chosen in different files by different hands. Google is not
   * consistent about where the version lives: Drive puts it in the host
   * (`www.googleapis.com/drive/v3` + `/about`), while Sheets and Docs put it in
   * the path (`sheets.googleapis.com` + `/v4/spreadsheets/...`). Copying a
   * neighbouring provider's shape is the obvious mistake, and it yields
   * `/v4/v4/...`, a 404 on every call, and nothing anywhere saying why —
   * discovery succeeds, registration succeeds, the tool lists fine.
   */
  test.each(httpProviders.map((m) => [m.id, m] as const))(
    '%s base_url matches the spec server',
    async (_id, manifest) => {
      const connector = manifest.connector as { base_url: string; openapi: string };
      const spec = (await Bun.file(connector.openapi).json()) as {
        servers?: { url: string }[];
      };

      const declared = spec.servers?.[0]?.url;
      expect(declared).toBeDefined();
      expect(connector.base_url.replace(/\/$/, '')).toBe(String(declared).replace(/\/$/, ''));
    },
  );

  /**
   * The other way a tools array stops being servable: sheer size.
   *
   * `mcp-from-openapi` inlines `$ref`s, so an operation's cost is not its size in
   * the document but its size once every reference below it has been expanded,
   * with shared sub-schemas duplicated per occurrence. Nothing about the spec
   * looks alarming when this happens. `sheets.spreadsheets.batchUpdate` — one
   * operation, a few hundred lines of OpenAPI — generated a 2,469KB input schema,
   * against 45KB for the whole of Drive, and it would have been sent on every
   * `tools/list`.
   *
   * `makeOpaque` in the vendoring script is the remedy. This is the alarm, and it
   * belongs beside the property-name check because the failure is the same in
   * kind: the specs look fine, and the endpoint is unusable.
   *
   * The budget is generous on purpose. `drive.files.create` legitimately sits
   * around 37KB — the `File` resource has 62 properties — so this is not a style
   * rule about big schemas. It is a floor under the difference between big and
   * two thousand times too big.
   */
  const BUDGET_KB = 64;

  test.each(httpProviders.map((m) => [m.id, m] as const))(
    '%s stays inside the schema budget',
    async (_id, manifest) => {
      const connector = manifest.connector as { base_url: string; openapi: string };
      const capabilities = await createHttpConnector({
        baseUrl: connector.base_url,
        openapi: connector.openapi,
      }).discover({ manifest });

      const oversized = capabilities
        .map((capability) => ({
          name: capability.name,
          kb: Math.round(JSON.stringify(capability.inputSchema).length / 1024),
        }))
        .filter((entry) => entry.kb > BUDGET_KB)
        .map((entry) => `${entry.name} ${entry.kb}KB`);

      expect(oversized).toEqual([]);
    },
  );

  /**
   * The size nobody was measuring: the whole list, not one tool in it.
   *
   * `BUDGET_KB` is a floor under a single runaway schema. Every provider can sit
   * comfortably under it while the list a client is handed grows without limit,
   * one vendored operation at a time — and that total is what actually travels
   * on every `tools/list`, what a hosted client has to accept in one response,
   * and what decides whether a client injects the tools or hides them behind a
   * search of its own.
   *
   * Measured as what `registerDiscoveredTool` actually registers — `title`,
   * `description` and `inputSchema` — rather than as the whole discovered
   * capability. The difference is not a rounding error: a capability also
   * carries its `target`, the HTTP method, path and parameter mapping the
   * dispatcher routes with, and that never reaches a client. It is 53% of
   * Gmail's object and 29% of Drive's, so measuring the object would let a
   * provider trip this budget by growing a routing table that costs a client
   * nothing, and let one double its real payload while staying under.
   *
   * The number is a ratchet, not a target. Drive is 127KB on the wire across
   * nine operations, most of it the `File` resource inlined once per write.
   * Cutting that means `makeOpaque`, which buys bytes by taking away the schema
   * the model composes a request body against — a real trade, worth making
   * deliberately rather than to satisfy a test. So this carries the same
   * headroom the per-tool budget does: enough to catch a surface that grew by an
   * order of magnitude, not so tight that it demands the trade today.
   */
  const SURFACE_BUDGET_KB = 192;

  test.each(httpProviders.map((m) => [m.id, m] as const))(
    '%s keeps its whole advertised surface inside the budget',
    async (_id, manifest) => {
      const connector = manifest.connector as { base_url: string; openapi: string };
      const capabilities = await createHttpConnector({
        baseUrl: connector.base_url,
        openapi: connector.openapi,
      }).discover({ manifest });

      // What `registerDiscoveredTool` reads, and therefore what a client is
      // sent. The routing `target` beside it is the dispatcher's business.
      const bytes = capabilities.reduce(
        (total, { title, description, inputSchema }) =>
          total + JSON.stringify({ title, description, inputSchema }).length,
        0,
      );

      expect(Math.round(bytes / 1024)).toBeLessThanOrEqual(SURFACE_BUDGET_KB);
    },
  );

  /**
   * A hint that is declared but not delivered.
   *
   * `specs.test.ts` checks that a `hints` key names a real capability. This
   * checks the half that one cannot see: that the text actually arrives on the
   * description a client is served. The two failures look identical from the
   * outside — a tool nobody picks — and neither shows up as an error anywhere.
   *
   * Worth pinning because the delivery path is easy to lose. Hints are appended
   * during `discover()`, which means they live in the discovery cache, which
   * means a transport that stopped consulting `manifest.hints` would keep
   * serving correct-looking descriptions from whatever was cached last.
   */
  test.each(httpProviders.map((m) => [m.id, m] as const))(
    '%s delivers every hint it declares',
    async (_id, manifest) => {
      const declared = manifest.hints ?? {};
      if (Object.keys(declared).length === 0) return;

      const connector = manifest.connector as { base_url: string; openapi: string };
      const capabilities = await createHttpConnector({
        baseUrl: connector.base_url,
        openapi: connector.openapi,
      }).discover({ manifest });

      const undelivered = Object.entries(declared)
        .filter(([name, hint]) => {
          const capability = capabilities.find((entry) => entry.name === name);
          return !capability?.description.includes(hint);
        })
        .map(([name]) => name);

      expect(undelivered).toEqual([]);
    },
  );

  /**
   * A redaction key that names no argument keeps nothing, and says nothing.
   *
   * `specs.test.ts` already checks the *capability* half of a `redact` block —
   * that `users.drafts.delete` is a real operation. Nothing checked the other
   * half, and the other half is where the mistakes are: `redact` names the
   * arguments to keep verbatim, and an argument that does not exist is silently
   * dropped. The log then reads exactly as it does when redaction is working —
   * every value a type marker — so the failure is invisible at the only moment
   * anyone would look.
   *
   * It is not a hypothetical spelling worry. The generator renames an argument
   * whenever a path or query parameter collides with a body field, prefixing it
   * with where it came from: Gmail's `drafts.update` takes `pathId` and
   * `bodyId` rather than `id`, and Tasks' `tasks.insert` takes `queryParent`
   * beside the body's `parent`. Both are plausible to write as the plain name,
   * both would fail closed and quietly, and three separate comments in this
   * repository warn about it because nothing could catch it.
   *
   * Only `http` providers are checked, because only they have a discoverable
   * schema to check against. A capability authored in code declares its own
   * arguments beside its own `redact`, where the type checker sees both.
   */
  test.each(httpProviders.map((m) => [m.id, m] as const))(
    '%s redacts only arguments that exist',
    async (_id, manifest) => {
      const declared = manifest.redact ?? {};
      if (Object.keys(declared).length === 0) return;

      const connector = manifest.connector as { base_url: string; openapi: string };
      const capabilities = await createHttpConnector({
        baseUrl: connector.base_url,
        openapi: connector.openapi,
      }).discover({ manifest });

      // Mirrors `shortenName`: the provider prefix is stripped from an
      // operationId to form the capability name, so a `redact` block is keyed
      // the same way. `contacts` strips nothing, because Google's operationIds
      // there say `people`.
      const argumentsOf = new Map(
        capabilities.map((capability) => [
          capability.name,
          new Set(Object.keys((capability.inputSchema['properties'] ?? {}) as object)),
        ]),
      );

      const unknown = Object.entries(declared).flatMap(([name, keys]) => {
        const properties = argumentsOf.get(name);
        // A capability that does not exist at all is `specs.test.ts`'s report
        // to make, not this one's — failing twice for one typo says no more.
        if (!properties) return [];
        return keys.filter((key) => !properties.has(key)).map((key) => `${name}.${key}`);
      });

      expect(unknown).toEqual([]);
    },
  );

  test('no capability offers a way to supply its own credentials', () => {
    // Authentication belongs to the connector, which sets a header. A query
    // parameter named `access_token` would let an agent authenticate as
    // something else entirely.
    const forbidden = ['access_token', 'key', 'oauth_token'];

    return Promise.all(
      httpProviders.map(async (manifest) => {
        const connector = manifest.connector as { base_url: string; openapi: string };
        const capabilities = await createHttpConnector({
          baseUrl: connector.base_url,
          openapi: connector.openapi,
        }).discover({ manifest });

        for (const capability of capabilities) {
          const properties = Object.keys(
            (capability.inputSchema['properties'] ?? {}) as Record<string, unknown>,
          );
          expect(properties.filter((name) => forbidden.includes(name))).toEqual([]);
        }
      }),
    );
  });
});
