import { z } from 'zod';
import {
  defineLocalProvider,
  keepKeys,
  redaction,
  type Capability,
  type ProviderDefinition,
} from '#connectivity';
import { assertItemId, type VaultStore } from '#secrets';

/**
 * `vault` — the owner's own secret material.
 *
 * Three properties, each of which is a decision recorded in ADR-012:
 *
 * **Tools only, never resources.** Resources are listable and cacheable, and
 * both are wrong for a secret (`docs/detailed/providers.md`).
 *
 * **Per-item policy through the capability name.** Each stored item gets its own
 * read capability — `vault.get.github_token` — so `deny: [vault.get.bank]` and
 * `allow: [vault.get.*]` are both already expressible against the policy engine
 * exactly as it stands. The alternative was teaching policy about arguments,
 * which `packages/core/src/config/schema.ts` warns against by name: a policy
 * expression language is a language with its own bugs, and a bug here is the one
 * this project cannot afford.
 *
 * Because capabilities are fixed for the life of a process, the item list is
 * read from the store when the runtime is built. **An item written by
 * `vault.put` is not readable until the endpoint restarts.** That is a feature:
 * a write cannot hand itself a read, so granting access to a new secret is a
 * deliberate act by the operator between two runs.
 *
 * There is deliberately no `vault.list`. The policy-filtered tool list *is* the
 * listing, and it is the only one that cannot over-report — an agent granted one
 * item cannot discover that the others exist.
 *
 * **A separate store and a separate encryption key.** Never `SecretStore`.
 * See `vault-store.ts`; the store arrives as a constructor argument rather than
 * through `ProviderContext`, because `ProviderContext` deliberately carries no
 * path to any raw backend.
 */

export interface VaultProviderOptions {
  readonly store: VaultStore;
  /**
   * Which items exist, read from the store at startup. Each becomes a
   * `vault.get.<id>` capability.
   *
   * Passed in rather than read here because building a provider is synchronous
   * and reading an encrypted file is not — and because the runtime is the right
   * place to decide when the store is opened.
   */
  readonly items?: ReadonlyArray<{ id: string; description?: string }>;
}

export function createVaultProvider(options: VaultProviderOptions): ProviderDefinition {
  const { store } = options;

  // Deduplicated across connections: a capability id is provider-wide, so two
  // connections holding an item of the same name contribute one capability. The
  // handler still reads from the invoked connection's own namespace, so the two
  // values never mix.
  const items = new Map<string, string | undefined>();
  for (const item of options.items ?? []) {
    if (!items.has(item.id)) items.set(item.id, item.description);
  }

  const reads: Capability[] = [...items].map(([id, description]) => ({
    kind: 'tool' as const,
    name: `get.${id}`,
    title: `Read vault item "${id}"`,
    description:
      description ??
      `Return the stored value of vault item "${id}". Handle it as a secret: it is the owner's credential, not context to quote back.`,
    inputSchema: z.object({}),
    // Nothing to redact — the id is in the capability name, which the audit
    // event records as `capability`, and there are no arguments at all.
    async handler(_input, context) {
      const item = await store.get(context.connection.id, id);
      if (!item) {
        return {
          content: [{ type: 'text', text: `No vault item "${id}" on ${context.connection.key}.` }],
          isError: true,
        };
      }

      // Length rather than value: enough to tell a truncated paste from a
      // correct one, and it never reaches the log as the value itself.
      context.audit.annotate({ item: id, bytes: item.value.length });
      return { content: [{ type: 'text', text: item.value }] };
    },
  }));

  return defineLocalProvider({
    id: 'vault',
    name: 'Vault',
    version: '1.0.0',
    description:
      "The owner's own passwords and API keys, in a store separate from the system's credentials and under a separate key. Reads are granted one item at a time.",

    configSchema: z.object({}),
    connectionSchema: z.object({}),

    bundles: [
      {
        name: 'read',
        description: 'Read stored items. Grant one at a time, not as a bundle.',
        oauth_scopes: [],
        capabilities: [...items.keys()].map((id) => `get.${id}`),
        default: true,
      },
      {
        name: 'write',
        description: 'Store and remove items.',
        oauth_scopes: [],
        capabilities: ['put', 'remove'],
      },
    ],

    capabilities: [
      ...reads,

      {
        kind: 'tool',
        name: 'put',
        title: 'Store a vault item',
        description:
          'Store or replace a secret under an id. The item becomes readable only after the endpoint restarts, and only if policy grants "vault.get.<id>" — a write cannot grant itself a read.',
        inputSchema: z.object({
          id: z
            .string()
            .min(1)
            .describe('Item id: lowercase letters, digits and "_". Becomes part of a capability name.'),
          value: z.string().min(1).describe('The secret to store'),
          description: z.string().optional().describe('What this is, for the operator'),
        }),
        // The id and its description are names worth recording — an audit log
        // that cannot say *which* item was written answers very little. The
        // value is withheld outright rather than type-marked, because
        // `<string:40>` still discloses a secret's length. Redaction resolves
        // before the policy decision in `dispatch.ts`, so a denied call is
        // redacted identically to an allowed one.
        redact: redaction({ keep: ['id', 'description'], withhold: ['value'] }),
        async handler({ id, value, description }, context) {
          assertItemId(id);
          await store.put(context.connection.id, {
            id,
            value,
            ...(description ? { description } : {}),
          });

          context.audit.annotate({ item: id, bytes: value.length });

          return {
            content: [
              {
                type: 'text',
                text:
                  `Stored vault item "${id}" on ${context.connection.key}. ` +
                  `It is not readable yet: restart the endpoint, and allow "vault.get.${id}" in policy.`,
              },
            ],
          };
        },
      },

      {
        kind: 'tool',
        name: 'remove',
        title: 'Remove a vault item',
        description: 'Delete a stored item. Its read capability disappears when the endpoint restarts.',
        inputSchema: z.object({
          id: z.string().min(1).describe('Item id'),
        }),
        redact: keepKeys('id'),
        async handler({ id }, context) {
          const removed = await store.delete(context.connection.id, id);

          return {
            content: [
              {
                type: 'text',
                text: removed
                  ? `Removed vault item "${id}" from ${context.connection.key}.`
                  : `No vault item "${id}" on ${context.connection.key}.`,
              },
            ],
            ...(removed ? {} : { isError: true }),
          };
        },
      },
    ],
  });
}
