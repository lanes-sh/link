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

describe('a provider whose client somebody else operates', () => {
  const broker = { url: 'https://api.example.com/v1/auth/link/vendor', operator: 'Someone' };

  const brokered = defineProvider({
    id: 'vendor_mail',
    name: 'Vendor Mail',
    description: 'Mail.',
    connector: { kind: 'http', base_url: 'https://api.test', openapi: './t.json' },
    auth: {
      kind: 'oauth',
      registration: 'manual',
      app: 'vendor',
      scopes: ['a'],
      authorize_url: 'https://accounts.example.com/o/oauth2/v2/auth',
      token_url: 'https://oauth2.example.com/token',
      broker,
    },
    setup: {
      steps: ['Create a project', 'Copy the client id and secret'],
      prompts: [
        { key: 'client_id', label: 'Client id', credential_ref: 'vendor/client_id' },
        { key: 'client_secret', label: 'Client secret', secret: true, credential_ref: 'vendor/client_secret' },
      ],
    },
  });

  test('needs nothing, and says the difference between that and needing nothing', () => {
    const plan = planFor(brokered, { profile: 'personal', connections: [] });

    expect(plan.requires).toEqual([]);
    expect(plan.brokered).toBe(true);
    expect(plan.clientOperator).toBe('Someone');
    expect(plan.ownClientCommand).toBe(
      'lanes link connect vendor_mail --profile personal --own-client',
    );
  });

  test('a profile that has registered its own client is asked for it, as before', () => {
    // Declaring the oauth_apps entry is the opt-out. Someone who has already
    // taken it must not be told they need nothing and then asked for two values.
    const plan = planFor(brokered, {
      profile: 'personal',
      connections: [],
      ownClients: ['vendor'],
    });

    expect(plan.brokered).toBe(false);
    expect(plan.requires.map((r) => r.ref)).toEqual(['vendor/client_id', 'vendor/client_secret']);
    expect(plan.ownClientCommand).toBeUndefined();
  });

  test('the console walkthrough survives in the data for whoever still needs it', () => {
    // Suppressing it is a rendering decision. A console with a disclosure and a
    // terminal that heads it "or register your own" both need it present.
    expect(planFor(brokered, { profile: 'personal', connections: [] }).steps).toHaveLength(2);
  });
});

/**
 * The target, for a caller that knows which one it is rendering for.
 *
 * Credentials are per-target, so `connect` writes into whichever target the
 * pasted command resolves to — and the shell it lands in resolves its own,
 * from `LANES_LINK_TARGET` or `instance.default_target`. That is the same
 * guess `--profile` exists to close, one axis over.
 *
 * Optional rather than required because the two callers that predate it have
 * no target to give: `setup plan` and the `setup.provider` capability both
 * render from manifests alone. Their output is unchanged, which is what the
 * first test here pins.
 */
describe('the target in a command', () => {
  test('a context with no target emits exactly what it always did', () => {
    expect(planFor(KEYED, context, 'work').command).toBe(
      'lanes link connect thing --profile personal --id work',
    );
  });

  test('names the target beside the profile when the caller knows it', () => {
    const targeted = { ...context, target: 'local' };

    expect(planFor(KEYED, targeted, 'work').command).toBe(
      'lanes link connect thing --profile personal --target local --id work',
    );
  });

  test('an id placeholder still comes last, so the part to edit is at the end', () => {
    const targeted = { ...context, target: 'local' };

    expect(planFor(KEYED, targeted).command).toBe(
      'lanes link connect thing --profile personal --target local --id <name>',
    );
  });

  test('the own-client escape hatch carries it too', () => {
    // It is the same command plus a flag, so a target on one and not the other
    // would send the reader to a different store than the line above it.
    const plan = planFor(BROWSER, { ...context, target: 'cloud' });

    expect(plan.command).toContain('--target cloud');
  });

  test('every shipped provider carries it', () => {
    for (const plan of planAll(PROVIDER_MANIFESTS, { ...context, target: 'cloud' })) {
      expect(plan.command).toContain('--target cloud');
      if (plan.ownClientCommand) expect(plan.ownClientCommand).toContain('--target cloud');
    }
  });
});
