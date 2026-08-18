import { describe, expect, test } from 'bun:test';
import {
  EMPTY_POLICY,
  allowedConnections,
  capabilityMatches,
  evaluate,
  evaluateDocument,
  type PolicyDocument,
} from './index.ts';

const OWNER = 'personal:owner';

const doc = (...rules: PolicyDocument['rules']): PolicyDocument => ({ rules });

describe('capability matching', () => {
  test('matches exactly', () => {
    expect(capabilityMatches('gmail.search', 'gmail.search')).toBe(true);
    expect(capabilityMatches('gmail.search', 'gmail.send')).toBe(false);
  });

  test('matches a trailing .* against the same namespace', () => {
    expect(capabilityMatches('gmail.*', 'gmail.search')).toBe(true);
    expect(capabilityMatches('gmail.*', 'gmail.get_message')).toBe(true);
  });

  test('a trailing .* does not cross into a differently-named provider', () => {
    // The dot must be part of the prefix, or `gmail.*` would match
    // `gmailx.search` — a provider someone else could install.
    expect(capabilityMatches('gmail.*', 'gmailx.search')).toBe(false);
    expect(capabilityMatches('gmail.*', 'gmail')).toBe(false);
  });

  test('a bare * matches everything', () => {
    expect(capabilityMatches('*', 'gmail.search')).toBe(true);
    expect(capabilityMatches('*', 'notion.get-comments')).toBe(true);
  });

  test('no other wildcard form is honoured', () => {
    expect(capabilityMatches('gmail.*.read', 'gmail.labels.read')).toBe(false);
    expect(capabilityMatches('gm*', 'gmail.search')).toBe(false);
    expect(capabilityMatches('*.search', 'gmail.search')).toBe(false);
  });
});

describe('default deny', () => {
  test('an empty policy grants nothing', () => {
    const decision = evaluateDocument(EMPTY_POLICY, {
      principal: OWNER,
      capability: 'example.echo',
      connection: 'example.a',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('denied_default');
  });

  test('a rule for another provider does not grant this one', () => {
    const policy = doc({ capability: 'notion.*', effect: 'allow' });
    expect(
      evaluateDocument(policy, {
        principal: OWNER,
        capability: 'example.echo',
        connection: 'example.a',
      }).allowed,
    ).toBe(false);
  });
});

describe('rules govern every account of a provider alike', () => {
  // The simplification that replaced per-connection rules: a profile's grant
  // covers all of its accounts for that provider, and separating two accounts
  // means running two profiles, which share no database and no credential
  // store. They do share an endpoint, so that separation is enforced per call.
  const policy = doc({ capability: 'gmail.*', effect: 'allow' });

  test('every declared account is covered', () => {
    for (const connection of ['gmail.work', 'gmail.personal']) {
      expect(
        evaluateDocument(policy, { principal: OWNER, capability: 'gmail.search', connection })
          .allowed,
      ).toBe(true);
    }
  });

  test('a deny covers every account too', () => {
    const withDeny = doc(
      { capability: 'gmail.*', effect: 'allow' },
      { capability: 'gmail.send', effect: 'deny' },
    );
    for (const connection of ['gmail.work', 'gmail.personal']) {
      expect(
        evaluateDocument(withDeny, { principal: OWNER, capability: 'gmail.send', connection })
          .allowed,
      ).toBe(false);
    }
  });
});

describe('deny precedence', () => {
  const request = {
    principal: OWNER,
    capability: 'gmail.send',
    connection: 'gmail.main',
  } as const;

  test('deny beats a broader allow regardless of rule order', () => {
    const denyFirst = doc(
      { capability: 'gmail.send', effect: 'deny' },
      { capability: 'gmail.*', effect: 'allow' },
    );
    const allowFirst = doc(
      { capability: 'gmail.*', effect: 'allow' },
      { capability: 'gmail.send', effect: 'deny' },
    );

    // Ordering in a config file must not be able to change the answer.
    expect(evaluateDocument(denyFirst, request).allowed).toBe(false);
    expect(evaluateDocument(allowFirst, request).allowed).toBe(false);
  });

  test('deny beats the catch-all allow that connect now writes', () => {
    // `allow: ['*']` is the default a fresh connection gets, so the very first
    // thing anyone does with policy is deny one capability out of it. If that
    // did not win, the default would be untightenable.
    const policy = doc({ capability: '*', effect: 'allow' }, { capability: 'gmail.send', effect: 'deny' });

    expect(evaluateDocument(policy, request).allowed).toBe(false);
    expect(
      evaluateDocument(policy, { ...request, capability: 'gmail.search' }).allowed,
    ).toBe(true);
  });

  test('approval_required fails closed while no engine exists', () => {
    const policy = doc(
      { capability: 'gmail.*', effect: 'allow' },
      { capability: 'gmail.send', effect: 'approval_required' },
    );
    expect(evaluateDocument(policy, request).allowed).toBe(false);
  });
});

describe('expiry', () => {
  const t = (iso: string) => new Date(iso);

  test('an expired allow stops granting', () => {
    const policy = doc({
      capability: 'example.echo',
      effect: 'allow',
      expiresAt: t('2026-01-01T00:00:00Z'),
    });
    const request = {
      principal: OWNER,
      capability: 'example.echo',
      connection: 'example.a',
    };

    expect(evaluateDocument(policy, { ...request, at: t('2025-12-31T00:00:00Z') }).allowed).toBe(true);
    expect(evaluateDocument(policy, { ...request, at: t('2026-06-01T00:00:00Z') }).allowed).toBe(false);
  });

  test('an expired deny stops denying rather than lingering', () => {
    const policy = doc(
      { capability: 'example.*', effect: 'allow' },
      {
        capability: 'example.echo',
        effect: 'deny',
        expiresAt: t('2026-01-01T00:00:00Z'),
      },
    );
    expect(
      evaluateDocument(policy, {
        principal: OWNER,
        capability: 'example.echo',
        connection: 'example.a',
        at: t('2026-06-01T00:00:00Z'),
      }).allowed,
    ).toBe(true);
  });
});

describe('tighten-only composition', () => {
  const request = {
    principal: OWNER,
    capability: 'gmail.search',
    connection: 'gmail.main',
  } as const;

  test('the profile cannot allow what the floor withheld', () => {
    const floor = EMPTY_POLICY; // grants nothing
    const profile = doc({ capability: 'gmail.*', effect: 'allow' });

    expect(evaluate(request, profile).allowed).toBe(true); // no floor: allowed
    expect(evaluate(request, profile, floor).allowed).toBe(false); // floor withholds
  });

  test('the profile cannot allow what the floor explicitly denied', () => {
    const floor = doc(
      { capability: 'gmail.*', effect: 'allow' },
      { capability: 'gmail.search', effect: 'deny' },
    );
    const profile = doc({ capability: 'gmail.search', effect: 'allow' });

    expect(evaluate(request, profile, floor).allowed).toBe(false);
  });

  test('a profile-level * cannot widen past the floor', () => {
    // The catch-all is a default, not an override. If `*` outranked the floor,
    // the floor would stop being a floor the moment anyone connected anything.
    const floor = doc({ capability: 'gmail.search', effect: 'allow' });
    const profile = doc({ capability: '*', effect: 'allow' });

    expect(evaluate(request, profile, floor).allowed).toBe(true);
    expect(
      evaluate({ ...request, capability: 'gmail.send' }, profile, floor).allowed,
    ).toBe(false);
  });

  test('the profile can narrow what the floor permitted', () => {
    const floor = doc({ capability: 'gmail.*', effect: 'allow' });
    const profile = doc(
      { capability: 'gmail.*', effect: 'allow' },
      { capability: 'gmail.search', effect: 'deny' },
    );

    expect(evaluate(request, profile, floor).allowed).toBe(false);
    expect(
      evaluate({ ...request, capability: 'gmail.get_message' }, profile, floor).allowed,
    ).toBe(true);
  });
});

describe('discovery filtering', () => {
  const connections = ['example.a', 'example.b', 'example.c'];

  test('a granted capability exposes every account; an ungranted one exposes none', () => {
    const policy = doc({ capability: 'example.get_note', effect: 'allow' });

    expect(allowedConnections('example.get_note', connections, OWNER, policy)).toEqual(connections);
    expect(allowedConnections('example.set_note', connections, OWNER, policy)).toEqual([]);
    expect(allowedConnections('example.echo', connections, OWNER, EMPTY_POLICY)).toEqual([]);
  });

  test('no connections means nothing to expose, rather than an error', () => {
    const policy = doc({ capability: '*', effect: 'allow' });
    expect(allowedConnections('example.echo', [], OWNER, policy)).toEqual([]);
  });

  test('a capability only ever offers its own provider’s accounts', () => {
    // Structural, not a policy decision: `gmail.search` must never list a
    // Notion account, however broad the grant. Under a catch-all this is the
    // only thing keeping the enum honest.
    const mixed = ['gmail.work', 'gmail.home', 'notion.main', 'example.a'];
    const policy = doc({ capability: '*', effect: 'allow' });

    expect(allowedConnections('gmail.search', mixed, OWNER, policy)).toEqual([
      'gmail.work',
      'gmail.home',
    ]);
    expect(allowedConnections('notion.search', mixed, OWNER, policy)).toEqual(['notion.main']);
    expect(allowedConnections('drive.search', mixed, OWNER, policy)).toEqual([]);
  });

  test('a provider whose name prefixes another is not confused for it', () => {
    // `gmail.` rather than `gmail`, or `gmailx.main` would come along too.
    const policy = doc({ capability: '*', effect: 'allow' });
    expect(allowedConnections('gmail.search', ['gmailx.main'], OWNER, policy)).toEqual([]);
  });

  test('discovery uses the same evaluation as invocation', () => {
    // If these could disagree, a leak in discovery would still be a leak.
    const policy = doc({ capability: 'example.echo', effect: 'allow' });
    for (const capability of ['example.echo', 'example.set_note']) {
      const visible = allowedConnections(capability, connections, OWNER, policy).length > 0;
      const invocable = evaluate(
        { principal: OWNER, capability, connection: 'example.a' },
        policy,
      ).allowed;
      expect(visible).toBe(invocable);
    }
  });
});

describe('dotted capability names', () => {
  // OpenAPI operationIds are routinely dotted, so a Gmail REST capability is
  // `gmail.users.drafts.send`. The grammar rejected dots until the HTTP
  // connector shipped, which made the deny command `connect` prints impossible
  // to write.
  test('an exact dotted capability matches', () => {
    expect(capabilityMatches('gmail.users.drafts.send', 'gmail.users.drafts.send')).toBe(true);
    expect(capabilityMatches('gmail.users.drafts.send', 'gmail.users.drafts.list')).toBe(false);
  });

  test('a wildcard narrows at any depth', () => {
    expect(capabilityMatches('gmail.users.*', 'gmail.users.drafts.send')).toBe(true);
    expect(capabilityMatches('gmail.users.drafts.*', 'gmail.users.drafts.send')).toBe(true);
    expect(capabilityMatches('gmail.users.drafts.*', 'gmail.users.labels.list')).toBe(false);
  });

  test('the provider wildcard still covers them', () => {
    expect(capabilityMatches('gmail.*', 'gmail.users.drafts.send')).toBe(true);
    expect(capabilityMatches('gmail.*', 'gmailx.users.drafts.send')).toBe(false);
  });

  test('a deny on one operation survives the catch-all allow', () => {
    const policy = doc(
      { capability: '*', effect: 'allow' },
      { capability: 'gmail.users.drafts.send', effect: 'deny' },
    );
    const at = { principal: OWNER, connection: 'gmail.main' };

    expect(evaluateDocument(policy, { ...at, capability: 'gmail.users.drafts.send' }).allowed).toBe(false);
    expect(evaluateDocument(policy, { ...at, capability: 'gmail.users.drafts.list' }).allowed).toBe(true);
  });
});
