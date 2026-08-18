import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createMemoryCredentials, createMemoryState } from '#stores/state/testing.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import { defineLocalProvider, type ProviderContext } from '#connectivity';
import { exampleProvider } from '#providers/example/provider.ts';
import {
  createMemoryVaultStore,
  createSetupProvider,
  createSkillsProvider,
  createVaultProvider,
  memoryProvider,
} from '#providers/owner.ts';
import { buildProviderContext } from './context.ts';
import { ProviderRegistry } from '#registry';

/**
 * ADR-007: control-plane operations are CLI-only and must never be reachable
 * through MCP.
 *
 * Policy changes, token management, credential writing, config mutation,
 * reading raw credential values, and audit mutation each authorise *future*
 * agent behaviour, so the decision has to originate outside the agent. A
 * prompt-injected or confused client that could widen its own policy would
 * defeat the entire authorization layer in one call.
 *
 * When someone audits the CLI against the MCP surface, these will look like
 * capability-parity gaps. They are walls. This file is what stops them being
 * "completed" by accident.
 */

/** Capability names that would expose a control-plane operation. */
const FORBIDDEN_CAPABILITY_PATTERNS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /policy/i, why: 'granting or revoking a rule' },
  { pattern: /(^|[._])(token|bearer)/i, why: 'minting or reading a client token' },
  { pattern: /credential|secret|password/i, why: 'reading or writing a credential' },
  { pattern: /(^|[._])config/i, why: 'mutating configuration' },
  { pattern: /(^|[._])(connect|authorize|oauth)/i, why: 'creating a connection or running OAuth' },
  { pattern: /audit/i, why: 'reading or mutating the audit log' },
  { pattern: /(^|[._])(grant|revoke|allow|deny)/i, why: 'changing what is permitted' },
];

/**
 * Every provider that ships, including the owner layer.
 *
 * `allowReserved` is what admits `memory`, `skills`, and `vault` — the same opt
 * in `buildRegistry` makes, and the only one. The vault is built with **no
 * items** on purpose: a `vault.get.<id>` capability carries an id the *owner*
 * chose, which is their data rather than a name this project ships, and an item
 * called `github_token` would trip the token pattern below for no good reason.
 * What is asserted here is the surface we author.
 */
function registryWithBuiltins(): ProviderRegistry {
  const registry = new ProviderRegistry({ allowReserved: true });

  registry.register(exampleProvider);
  registry.register(memoryProvider);
  registry.register(createSkillsProvider({ skills: [] }));
  registry.register(createVaultProvider({ store: createMemoryVaultStore(), items: [] }));
  // Read-only by construction (ADR-019): it describes setup, and describing
  // authorises nothing. Built with no catalogue for the same reason the vault is
  // built with no items — a provider id in the catalogue is data, and what is
  // asserted here is the surface we author.
  registry.register(createSetupProvider({ profile: 'personal' }));

  return registry;
}

describe('no registered capability maps to a control-plane operation', () => {
  test('every built-in capability name is clean', () => {
    const offences: string[] = [];

    for (const { id } of registryWithBuiltins().capabilities()) {
      for (const { pattern, why } of FORBIDDEN_CAPABILITY_PATTERNS) {
        if (pattern.test(id)) offences.push(`${id} looks like ${why}`);
      }
    }

    expect(offences).toEqual([]);
  });

  test('the assertion would actually catch a violation', () => {
    // A guard that cannot fail is not a guard. This proves the patterns bite.
    const rogue = defineLocalProvider({
      id: 'rogue',
      name: 'Rogue',
      version: '1.0.0',
      description: 'a provider that tries to expose the control plane',
      configSchema: z.object({}),
      connectionSchema: z.object({}),
      capabilities: [
        {
          kind: 'tool',
          name: 'grant_policy',
          description: 'widen my own permissions',
          inputSchema: z.object({}),
          async handler() {
            return { content: [] };
          },
        },
      ],
    });

    const registry = new ProviderRegistry();
    registry.register(rogue);

    const flagged = registry
      .capabilities()
      .filter(({ id }) => FORBIDDEN_CAPABILITY_PATTERNS.some(({ pattern }) => pattern.test(id)));

    expect(flagged.map((entry) => entry.id)).toEqual(['rogue.grant_policy']);
  });

  /**
   * The patterns are unanchored, which is easy to forget and expensive to
   * rediscover.
   *
   * `setup.overview` and `setup.provider` are clean; the names somebody would
   * reach for first are not. `.connect` matches inside `.connection_steps`, so a
   * capability describing how to connect trips the rule against *creating* a
   * connection. That is the rule being blunt rather than wrong — it cannot read
   * intent — but it means renaming one of those two capabilities is a change to
   * whether the suite passes, not a matter of taste.
   */
  test('the near misses a setup surface would reach for are all refused', () => {
    const nearMisses = [
      'setup.connection_steps',
      'setup.credentials_needed',
      'setup.config_path',
      'setup.policy_rules',
      'setup.allowed',
      'setup.token_hint',
      'setup.oauth_steps',
    ];

    for (const id of nearMisses) {
      expect(FORBIDDEN_CAPABILITY_PATTERNS.some(({ pattern }) => pattern.test(id))).toBe(true);
    }

    for (const id of ['setup.overview', 'setup.provider']) {
      expect(FORBIDDEN_CAPABILITY_PATTERNS.some(({ pattern }) => pattern.test(id))).toBe(false);
    }
  });
});

describe('the provider context exposes no control-plane handle', () => {
  function contextFor(): ProviderContext {
    return buildProviderContext({
      manifest: exampleProvider.manifest,
      definition: exampleProvider,
      connection: { id: 'a', provider: 'example', account: 'A' },
      state: createMemoryState(),
      credentials: createMemoryCredentials({ 'gmail/main': 'refresh-token' }),
      storage: createMemoryBlobStore(),
      audit: { annotate() {} },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
    });
  }

  test('is exactly the documented surface and nothing more', () => {
    // A new key appearing here is a design decision, not an implementation
    // detail — hence asserting the whole set rather than spot-checking.
    expect(Object.keys(contextFor()).sort()).toEqual([
      'audit',
      'connection',
      'credentials',
      'log',
      'signal',
      'state',
      'storage',
    ]);
  });

  test('carries no unscoped store, config, policy, or registry', () => {
    const surface = contextFor() as unknown as Record<string, unknown>;

    // `state` is deliberately absent from this list: a provider *is* handed one,
    // scoped to `<provider>/<connection>` by core before it arrives. What it
    // must never reach is the whole `RuntimeState` — the connection rows and
    // the cursors beside its own namespace, which is what `database` named
    // before the log and the store were separated.
    for (const forbidden of [
      'connections',
      'cursors',
      'database',
      'db',
      'config',
      'policy',
      'registry',
      'dispatcher',
    ]) {
      expect(surface[forbidden]).toBeUndefined();
    }
  });

  test('credentials are read-only — no set, delete, or list', () => {
    const credentials = contextFor().credentials as unknown as Record<string, unknown>;

    expect(Object.keys(credentials).sort()).toEqual(['get', 'has']);
    for (const forbidden of ['set', 'delete', 'list', 'keys']) {
      expect(credentials[forbidden]).toBeUndefined();
    }
  });

  test('a provider cannot read a credential outside its own connection', async () => {
    // The example provider declares no credential refs and its connection
    // carries none, so its allowlist is empty and everything is out of scope.
    await expect(contextFor().credentials.get('gmail/main')).rejects.toThrow(/not in scope/);
    await expect(contextFor().credentials.get('profile/token')).rejects.toThrow(/not in scope/);
  });

  test('the audit handle can annotate but cannot read or mutate the log', () => {
    const audit = contextFor().audit as unknown as Record<string, unknown>;

    expect(Object.keys(audit)).toEqual(['annotate']);
    for (const forbidden of ['tail', 'query', 'read', 'append', 'delete', 'update']) {
      expect(audit[forbidden]).toBeUndefined();
    }
  });
});

describe('the owner-layer namespaces stay reserved', () => {
  function squatter(id: string) {
    return defineLocalProvider({
      id,
      name: id,
      version: '1.0.0',
      description: 'squatter',
      configSchema: z.object({}),
      connectionSchema: z.object({}),
      capabilities: [],
    });
  }

  test('memory, skills, and vault cannot be claimed by a provider', () => {
    // Still refused by default now that the owner layer has shipped. The guard
    // was never about the layer being unbuilt: reclaiming a namespace once
    // providers exist in the wild would silently change what a policy rule
    // means, and that is as true today as it was in M1.
    const registry = new ProviderRegistry();

    for (const id of ['memory', 'skills', 'vault']) {
      expect(() => registry.register(squatter(id))).toThrow(/reserved for the owner layer/);
    }
  });

  test('one construction site opts in, and it is the built-in registry', () => {
    // `buildRegistry` in the CLI passes `allowReserved`; a workspace manifest
    // is registered into that same registry afterwards, so this is what stops
    // one shadowing `vault` — the id is already taken by then.
    const registry = new ProviderRegistry({ allowReserved: true });
    registry.register(memoryProvider);

    expect(() => registry.register(squatter('memory'))).toThrow(/already registered/);
  });
});

describe('vault will not be able to reach the credential store', () => {
  test('a provider context has no path to the full SecretStore', () => {
    // The M3 vault holds the owner's own secrets and is reachable under policy.
    // The credential store holds what authorises the system itself and must
    // never be. This test exists before the vault does, because sharing one
    // store would mean a single policy bug leaks the credentials that make
    // policy meaningful.
    const context = contextSurface();

    expect(context['credentialStore']).toBeUndefined();
    expect(context['credentials']).toBeDefined();
    expect(Object.keys(context['credentials'] as object).sort()).toEqual(['get', 'has']);
  });

  function contextSurface(): Record<string, unknown> {
    return buildProviderContext({
      manifest: exampleProvider.manifest,
      definition: exampleProvider,
      connection: { id: 'a', provider: 'example', account: 'A' },
      state: createMemoryState(),
      credentials: createMemoryCredentials(),
      storage: createMemoryBlobStore(),
      audit: { annotate() {} },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
    }) as unknown as Record<string, unknown>;
  }
});
