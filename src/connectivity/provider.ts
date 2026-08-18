import { z } from 'zod';
import type { SecretRef } from '#secrets';
import type { Capability } from './capability.ts';
import type { ProviderContext } from './context.ts';
import { bundleSchema, defineProvider, type ProviderManifest } from './manifest/index.ts';

/**
 * Local providers — the only kind that still carries code.
 *
 * Everything reachable over MCP or HTTP is a manifest; this exists for
 * capabilities that *are* ours: `example`, and the M3 owner layer (memory,
 * skills, vault), which hold no third-party account and could not be expressed
 * as an upstream call.
 *
 * A local provider is a manifest **plus** handlers, so the registry holds one
 * shape regardless of connectivity.
 */

/** Local providers hold no third-party account, so this is always `none`. */
export type AuthRequirement = { readonly kind: 'none' };

export interface ProviderDefinition<
  ConfigSchema extends z.ZodType = z.ZodType,
  ConnectionSchema extends z.ZodType = z.ZodType,
> {
  readonly manifest: ProviderManifest;

  /** Provider-level settings from the `providers:` block. */
  readonly configSchema: ConfigSchema;
  /** Per-connection settings from a `connections:` entry. */
  readonly connectionSchema: ConnectionSchema;

  readonly capabilities: readonly Capability[];

  /**
   * Which credential refs a connection may read. Core turns this into the
   * allowlist behind `ProviderContext.credentials`, so a provider cannot reach
   * a ref it did not declare.
   */
  credentialRefs?(connectionId: string, config: unknown): readonly SecretRef[];

  /** Optional readiness probe surfaced by `doctor`. Never called during dispatch. */
  healthcheck?(context: ProviderContext): Promise<{ ok: boolean; detail?: string }>;
}

export interface LocalProviderInput<C extends z.ZodType, N extends z.ZodType> {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly configSchema: C;
  readonly connectionSchema: N;
  readonly capabilities: readonly Capability[];
  readonly bundles?: readonly z.input<typeof bundleSchema>[];
  readonly redact?: ProviderManifest['redact'];
  credentialRefs?(connectionId: string, config: unknown): readonly SecretRef[];
  healthcheck?(context: ProviderContext): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Define a local provider. Validates eagerly, so a malformed one fails at
 * import rather than at first invocation.
 */
export function defineLocalProvider<C extends z.ZodType, N extends z.ZodType>(
  input: LocalProviderInput<C, N>,
): ProviderDefinition<C, N> {
  const seen = new Set<string>();
  for (const capability of input.capabilities) {
    if (seen.has(capability.name)) {
      throw new Error(`Provider ${input.id} declares capability ${capability.name} twice`);
    }
    seen.add(capability.name);
  }

  for (const bundle of input.bundles ?? []) {
    for (const name of bundle.capabilities ?? []) {
      // Local bundles name capabilities exactly; globs are for discovered ones,
      // where we do not know the names in advance.
      if (!name.includes('*') && !seen.has(name)) {
        throw new Error(
          `Provider ${input.id} bundle "${bundle.name}" references unknown capability "${name}"`,
        );
      }
    }
  }

  const manifest = defineProvider({
    id: input.id,
    name: input.name,
    version: input.version ?? '1.0.0',
    description: input.description ?? '',
    connector: { kind: 'local' },
    auth: { kind: 'none' },
    ...(input.bundles ? { bundles: input.bundles } : {}),
    ...(input.redact ? { redact: input.redact } : {}),
  });

  return {
    manifest,
    configSchema: input.configSchema,
    connectionSchema: input.connectionSchema,
    capabilities: input.capabilities,
    ...(input.credentialRefs ? { credentialRefs: input.credentialRefs } : {}),
    ...(input.healthcheck ? { healthcheck: input.healthcheck } : {}),
  };
}

/**
 * A manifest-based provider that also carries a few capabilities of its own.
 *
 * The exception, not the pattern. A provider is a declaration precisely so that
 * `providers/gmail` can be fifteen lines of data instead of six hundred lines of
 * endpoint translation, and every capability authored here is a step back
 * towards the latter. Reach for it only where the vendor's API can do something
 * its *document* cannot express — the case that forced it is mail, where sending
 * means handing over one assembled RFC 2822 message and no OpenAPI document
 * describes composing one, so the generated tool obliges the caller to build it
 * and therefore to carry the attachment as base64.
 *
 * Everything else stays as declared: the connector kind, the auth, the discovered
 * capabilities. `createCompositeConnector` answers the authored names and
 * delegates the rest, and the registry adds both sets together with authored
 * winning a collision.
 *
 * There is no `configSchema` or `connectionSchema` argument. Those describe
 * settings a *local* provider reads from the profile, and a manifest provider's
 * connection is already described by its manifest — so they are permissive here
 * rather than inviting a second place to declare the same thing.
 */
export function defineProviderWithCapabilities(input: {
  readonly manifest: ProviderManifest;
  readonly capabilities: readonly Capability[];
}): ProviderDefinition {
  if (input.manifest.connector.kind === 'local') {
    throw new Error(
      `Provider "${input.manifest.id}" is a local connector, so it should use defineLocalProvider — there is no remote half to compose with.`,
    );
  }

  if (input.capabilities.length === 0) {
    throw new Error(
      `Provider "${input.manifest.id}" authors no capabilities, so it is an ordinary manifest — register it directly.`,
    );
  }

  const seen = new Set<string>();
  for (const capability of input.capabilities) {
    if (seen.has(capability.name)) {
      throw new Error(
        `Provider ${input.manifest.id} declares capability ${capability.name} twice`,
      );
    }
    seen.add(capability.name);
  }

  return {
    manifest: input.manifest,
    // Permissive on purpose: see the note above.
    configSchema: z.unknown(),
    connectionSchema: z.unknown(),
    capabilities: input.capabilities,
  };
}
