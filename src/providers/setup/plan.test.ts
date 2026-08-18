import { describe, expect, test } from 'bun:test';
import { defineProvider } from '#connectivity';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import { planAll, planFor } from './plan.ts';

/**
 * What connecting a provider involves.
 *
 * The property that matters is that the emitted command is one that works. This
 * is rendered both to a terminal and to a model whose job is to hand a person
 * something to paste, so a command aimed at the wrong profile, or missing the
 * `--id` its own requirements need, is a wrong answer that reads like a right
 * one.
 */

const KEYED = defineProvider({
  id: 'thing',
  name: 'Thing',
  version: '1.0.0',
  description: 'a provider with one per-account key',
  connector: { kind: 'http', base_url: 'https://example.test', openapi: './x.json' },
  auth: { kind: 'header', header: 'X-Key' },
  setup: {
    steps: ['Make a key'],
    prompts: [{ key: 'key', label: 'API key', secret: true, scope: 'connection', field: 'value' }],
  },
});

const BROWSER = defineProvider({
  id: 'cloudy',
  name: 'Cloudy',
  version: '1.0.0',
  description: 'a provider that authorises in a browser',
  connector: { kind: 'mcp', endpoint: 'https://mcp.example.test' },
  auth: { kind: 'oauth', scopes: ['read'] },
});

const context = { profile: 'personal', connections: ['thing.main', 'other.x'] };

describe('planFor', () => {
  test('always names the profile, never leaving it to the shell', () => {
    // One endpoint serves every profile, and the shell this gets pasted into
    // may default to a different one. `resolveSelection` refuses to guess for
    // exactly this reason; a command that omits it would reintroduce the guess.
    expect(planFor(KEYED, context, 'main').command).toContain('--profile personal');
    expect(planFor(BROWSER, context).command).toContain('--profile personal');
  });

  test('a per-account provider with no id asks for one in the command itself', () => {
    const plan = planFor(KEYED, context);

    expect(plan.needsId).toBe(true);
    expect(plan.command).toBe('lanes link connect thing --profile personal --id <name>');
  });

  test('a named connection puts its id in the command instead of a placeholder', () => {
    const plan = planFor(KEYED, context, 'work');

    expect(plan.needsId).toBe(false);
    expect(plan.command).toBe('lanes link connect thing --profile personal --id work');
    expect(plan.requires[0]?.ref).toBe('thing/work');
  });

  test('browser is the one bit that decides whether an agent can finish it', () => {
    expect(planFor(BROWSER, context).browser).toBe(true);
    expect(planFor(KEYED, context).browser).toBe(false);
  });

  test('reports only this provider’s own connections', () => {
    expect(planFor(KEYED, context).connected).toEqual(['thing.main']);
    expect(planFor(BROWSER, context).connected).toEqual([]);
  });

  test('carries the console steps, which are the part no command can do', () => {
    expect(planFor(KEYED, context).steps).toEqual(['Make a key']);
  });
});

describe('planAll', () => {
  test('every shipped provider produces a command naming that provider', () => {
    for (const plan of planAll(PROVIDER_MANIFESTS, context)) {
      expect(plan.command).toStartWith(`lanes link connect ${plan.id} `);
      expect(plan.command).toContain('--profile personal');
    }
  });

  test('a provider needing an id never emits a command without one', () => {
    // The pairing is the invariant: `needsId` exists to be acted on, and the
    // command is where acting on it shows up.
    for (const plan of planAll(PROVIDER_MANIFESTS, context)) {
      expect(plan.needsId).toBe(plan.command.includes('--id <name>'));
    }
  });

  test('is sorted, so two runs read the same', () => {
    const ids = planAll(PROVIDER_MANIFESTS, context).map((plan) => plan.id);
    expect(ids).toEqual([...ids].sort());
  });
});
