import { describe, expect, test } from 'bun:test';
import { MAX_INSTRUCTIONS, serverInstructions } from './instructions.ts';
import { allocatePort, startStdioHarness } from '../harness.ts';
import type { MergedCapability } from './visibility.ts';

/**
 * What a client is told before it calls anything.
 *
 * Two things are being checked, and they fail for different reasons. The
 * composition tests below say the right facts are assembled; the wire test at
 * the bottom says they actually arrive — `instructions` is a `ServerOptions`
 * field, and putting it in the `Implementation` argument beside `name` compiles,
 * runs, and silently sends nothing.
 */

/** A capability reachable on the given profiles. Only `reachable` is read here. */
function reaching(reachable: Record<string, string[]>): MergedCapability {
  return {
    reachable: new Map(Object.entries(reachable)),
    capability: undefined,
    discovered: undefined,
  };
}

describe('reaching the endpoint at all', () => {
  const one = new Map([['a.read', reaching({ personal: ['example.a'] })]]);

  test('a remote client is told a call may not land, and what that is not', () => {
    const text = serverInstructions(['personal'], one, true);

    expect(text).toContain('may simply not go through');
    // The two readings it exists to head off: a fault to chase, and lost
    // authorization. Both were observed in a transcript.
    expect(text).toContain('not authorization you have lost');
    expect(text).toContain('do not redo what already succeeded');
  });

  test('a local client is not, and pays nothing for it', () => {
    // Over a pipe or on loopback the client holds the skill, and the transport
    // cannot fail the way that paragraph describes. Two hundred characters on
    // every request is not a rounding error when it is every request forever.
    const remote = serverInstructions(['personal'], one, true);
    const local = serverInstructions(['personal'], one);

    expect(local).not.toContain('may simply not go through');
    expect(local.length).toBeLessThan(remote.length);
  });

  test('it does not cost the connection listing its detail', () => {
    // The listing degrades to a count when the prose crowds it out, which is
    // the failure mode of adding a paragraph. A workspace of one profile and a
    // handful of connections must still get the names.
    const text = serverInstructions(
      ['personal'],
      new Map([
        ['a.read', reaching({ personal: ['example.a', 'example.b', 'example.c'] })],
        ['a.write', reaching({ personal: ['example.d', 'example.e'] })],
      ]),
      true,
    );

    expect(text).toContain('personal: example.a, example.b, example.c, example.d, example.e');
    expect(text.length).toBeLessThan(MAX_INSTRUCTIONS);
  });
});

describe('the facts under the prose', () => {
  test('lists every profile served, with its connections', () => {
    const text = serverInstructions(
      ['personal', 'work'],
      new Map([
        ['a.read', reaching({ personal: ['example.a'], work: ['example.w'] })],
        ['a.write', reaching({ personal: ['example.b'] })],
      ]),
    );

    expect(text).toContain('personal: example.a, example.b');
    expect(text).toContain('work: example.w');
  });

  test('a profile the principal cannot reach is not announced', () => {
    // Discovery filtering already dropped it from every tool. Naming it here
    // would describe a door that does not open.
    const text = serverInstructions(
      ['personal', 'locked'],
      new Map([['a.read', reaching({ personal: ['example.a'] })]]),
    );

    expect(text).toContain('personal:');
    expect(text).not.toContain('locked');
  });

  test('profiles keep the order they are served in, not the order found', () => {
    const text = serverInstructions(
      ['personal', 'work'],
      // `work` appears first among the capabilities.
      new Map([
        ['a.read', reaching({ work: ['example.w'] })],
        ['a.write', reaching({ personal: ['example.a'] })],
      ]),
    );

    expect(text.indexOf('personal:')).toBeLessThan(text.indexOf('work:'));
  });

  test('names the owner-layer providers that are reachable, and no others', () => {
    const text = serverInstructions(
      ['personal'],
      new Map([
        ['lanes_memory.search', reaching({ personal: ['lanes_memory.owner'] })],
        ['example.echo', reaching({ personal: ['example.a'] })],
      ]),
    );

    expect(text).toContain('memory');
    expect(text).not.toContain('vault');
  });

  test('says so plainly when nothing is reachable', () => {
    // A fresh workspace and a principal granted nothing both land here, and a
    // heading with nothing under it reads like a bug in the endpoint.
    const text = serverInstructions(['personal'], new Map());

    expect(text).toContain('Nothing is reachable');
    expect(text).not.toContain('Reachable now');
  });
});

describe('the habits it teaches', () => {
  const text = serverInstructions(
    ['personal'],
    new Map([['example.echo', reaching({ personal: ['example.a'] })]]),
  );

  test('states the profile rule as a rule, not as advice', () => {
    expect(text).toContain('Do not default to whichever is listed first');
  });

  test('covers each thing a client would otherwise have to guess', () => {
    // The unconditional half: routing, attachments, and what a refusal means
    // apply to every endpoint regardless of what it is granted.
    for (const habit of ['profile', 'connection', 'attachments', 'refused']) {
      expect(text).toContain(habit);
    }
  });

  test('does not teach habits for tools this principal has none of', () => {
    // It used to. Every client was told to consult memory, invoke skills and
    // guard vault values, on an endpoint granting none of the three — which is
    // the ordinary shape of a workspace that connected one mailbox. Prose the
    // tool list contradicts is worse than no prose: an agent resolves the
    // contradiction by guessing, which is the whole bug this file exists to
    // stop.
    expect(text).not.toContain('Memory is worth consulting');
    expect(text).not.toContain('Skills are the owner');
    expect(text).not.toContain('Vault values are credentials');
  });

  test('teaches them when the principal does have them', () => {
    const granted = serverInstructions(
      ['personal'],
      new Map([
        ['lanes_memory.search', reaching({ personal: ['lanes_memory.owner'] })],
        ['lanes_skills.manage.list', reaching({ personal: ['lanes_skills.owner'] })],
        ['lanes_vault.put', reaching({ personal: ['lanes_vault.owner'] })],
      ]),
    );

    expect(granted).toContain('Memory is worth consulting');
    expect(granted).toContain('Skills are the owner');
    expect(granted).toContain('Vault values are credentials');
  });

  /**
   * The observed failure, not a predicted one: asked to connect a second
   * mailbox, a client with no setup surface and no skill said it could not and
   * then invented the procedure. It had no way to know what answers that.
   */
  test('points at the setup surface when there is one', () => {
    const granted = serverInstructions(
      ['personal'],
      new Map([
        ['gmail.send', reaching({ personal: ['gmail.a'] })],
        ['lanes_setup.overview', reaching({ personal: ['lanes_setup.main'] })],
      ]),
    );

    expect(granted).toContain('lanes_setup_overview');
    expect(granted).toContain('inventing it is not');
  });

  /**
   * The paragraph that must not carry what it points at.
   *
   * Inlining the declaration was the obvious shape and is the wrong one: the
   * ceiling is fixed, so the workspace with the most identities to keep apart
   * is the one whose list would be summarised away first — and it would leak
   * every profile's names to a client that had asked about none of them. A
   * pointer costs the same at any size, so this asserts both halves: the
   * pointer is there, and no name came with it.
   */
  test('points at the declared identity without reciting it', () => {
    const granted = serverInstructions(
      ['personal'],
      new Map([
        ['gmail.send', reaching({ personal: ['gmail.a'] })],
        ['lanes_identity.list', reaching({ personal: ['lanes_identity.main'] })],
      ]),
    );

    expect(granted).toContain('lanes_identity_list');
    expect(granted).toContain('Identity is declared, not inferred');
    // The instruction is to fetch, so the fetchable part must not be here.
    expect(granted).not.toContain('note on when it applies.\n  ');
  });

  test('says nothing about identity for a profile that declares none', () => {
    // A profile with no identity block gets no `identity` connection, so the
    // capability is unreachable and the paragraph is unspent. Telling a client
    // to call a tool it cannot see is the contradiction the test above this one
    // exists to prevent.
    expect(text).not.toContain('lanes_identity_list');
    expect(text).not.toContain('Identity is declared');
  });

  test('says nothing about setup when there is no surface to point at', () => {
    expect(text).not.toContain('lanes_setup_overview');
  });

  test('does not call the setup surface the owner\'s own material', () => {
    // It is in RESERVED_PROVIDER_IDS beside memory, skills and vault, and used
    // to be swept into a trailing line naming all four as the owner's material.
    // It holds none: it describes what the others are.
    const granted = serverInstructions(
      ['personal'],
      new Map([['lanes_setup.overview', reaching({ personal: ['lanes_setup.main'] })]]),
    );

    expect(granted).not.toContain("owner's own material");
  });

  test('stays inside its budget however large the workspace is', () => {
    // The prose is fixed; the connection listing is not. Measuring only the
    // fixture above meant the budget was met by workspaces that happened to be
    // small — three profiles of ten accounts passed 2,000 characters silently.
    // Beyond a point the listing is summarised instead, which loses nothing an
    // agent cannot get exactly: every tool carries the connections it accepts in
    // its own `connection` enum.
    const profiles = ['personal', 'work', 'clients', 'archive', 'shared'];
    const reachable = new Map(
      profiles.map((profile) => [
        profile,
        Array.from({ length: 20 }, (_, i) => `provider${i}.account_${profile}_${i}`),
      ]),
    );
    const merged = new Map([
      ['x.y', { reachable, capability: undefined, discovered: undefined }],
    ]) as never;

    const large = serverInstructions(profiles, merged);

    expect(large.length).toBeLessThan(MAX_INSTRUCTIONS);
    // Still says what is reachable, and where the exact list is.
    expect(large).toContain('100 connections');
    expect(large).toContain('`connection`');
  });

  test('holds however large the workspace is, including the prose', () => {
    // "However large" was not what the test above measured. The summary drops
    // the connections but still named every profile, so twenty profiles put it
    // back over — and the prose is now assembled per principal, so the worst
    // case is every owner-layer provider granted at the same time. Both at once
    // is the case that has to hold.
    //
    // `remoteClients` is passed for the same reason. It was omitted here while
    // `AVAILABILITY` was the paragraph the ceiling had last been raised for — so
    // the case this test called the worst was ~180 characters short of one an
    // endpoint actually serves, and the ceiling it certified was the wrong
    // number to certify. Every paragraph that can be spent at once is spent
    // here, or the budget is guarded against a case that does not happen.
    const profiles = Array.from({ length: 20 }, (_, i) => `a-fairly-long-profile-name-${i}`);
    const reachable = new Map(
      profiles.map((profile) => [
        profile,
        Array.from({ length: 20 }, (_, i) => `provider${i}.account_${profile}_${i}`),
      ]),
    );
    const first = profiles[0] as string;

    const worst = serverInstructions(
      profiles,
      new Map([
        ['x.y', { reachable, capability: undefined, discovered: undefined }],
        ['lanes_memory.search', reaching({ [first]: ['lanes_memory.owner'] })],
        ['lanes_tasks.list', reaching({ [first]: ['lanes_tasks.owner'] })],
        ['lanes_assets.list', reaching({ [first]: ['lanes_assets.owner'] })],
        ['lanes_skills.manage.list', reaching({ [first]: ['lanes_skills.owner'] })],
        ['lanes_vault.put', reaching({ [first]: ['lanes_vault.owner'] })],
        ['lanes_setup.overview', reaching({ [first]: ['lanes_setup.main'] })],
        ['lanes_identity.list', reaching({ [first]: ['lanes_identity.main'] })],
      ]),
      true,
    );

    expect(worst.length).toBeLessThan(MAX_INSTRUCTIONS);
    // Degraded to a count rather than truncated: the names are the nicety, the
    // number is the fact, and every tool carries its own connection enum.
    expect(worst).toContain('20 profiles');
  });

  /**
   * The widest case is the one that looks narrower — memory reachable, tasks not.
   *
   * `MEMORY_AND_TASKS` replaces `MEMORY` rather than joining it, and is a little
   * shorter than the two apart, so a profile that *denied* tasks spends more
   * than one that has both. The test above would happily certify a ceiling this
   * case exceeds, which is the same mistake its own comment records being made
   * twice already — so the maximum is asserted against both branches.
   */
  test('the unpaired branch is the real maximum, and it fits too', () => {
    const profiles = Array.from({ length: 20 }, (_, i) => `a-fairly-long-profile-name-${i}`);
    const reachable = new Map(
      profiles.map((profile) => [
        profile,
        Array.from({ length: 20 }, (_, i) => `provider${i}.account_${profile}_${i}`),
      ]),
    );
    const first = profiles[0] as string;

    // Prefixed here rather than at every call: these are Lanes' own surfaces,
    // and the tests below read better naming the surface than the provider id.
    const owners = (bare: readonly string[]) => {
      const ids = bare.map((id) => `lanes_${id}`);
      return owner(ids);
    };

    const owner = (ids: readonly string[]) =>
      new Map([
        ['x.y', { reachable, capability: undefined, discovered: undefined }],
        ...ids.map(
          (id) =>
            [`${id}.list`, reaching({ [first]: [`${id}.owner`] })] as [
              string,
              ReturnType<typeof reaching>,
            ],
        ),
      ]);

    const everything = [
      'memory',
      'tasks',
      'assets',
      'skills',
      'vault',
      'setup',
      'identity',
      'entities',
    ];
    const without = (...drop: string[]) => everything.filter((id) => !drop.includes(id));
    const lengthOf = (ids: readonly string[]) =>
      serverInstructions(profiles, owners(ids), true).length;

    // Two independent pairs — memory/tasks and identity/entities — so there are
    // four combinations and the widest is not the one with the most providers
    // in it. Walking all four is the point: the last three raises to this
    // ceiling were each certified against a case an endpoint does not serve.
    const branches = [
      lengthOf(everything),
      lengthOf(without('tasks')),
      lengthOf(without('entities')),
      lengthOf(without('tasks', 'entities')),
    ];

    for (const length of branches) expect(length).toBeLessThan(MAX_INSTRUCTIONS);

    // The maximum is memory *unpaired* while identity and entities are paired:
    // it looks like the narrower configuration and costs the most, because
    // `MEMORY_AND_TASKS` is shorter than `MEMORY` and `TASKS` apart.
    expect(Math.max(...branches)).toBe(branches[1]!);
  });

  test('collapsing identity and entities is what keeps the ceiling where it is', () => {
    const profiles = ['personal'];
    const owners = (bare: readonly string[]) =>
      new Map(
        bare
          .map((id) => `lanes_${id}`)
          .map((id) => [`${id}.list`, reaching({ personal: [`${id}.owner`] })]),
      );

    const neither = serverInstructions(profiles, owners(['memory']), true).length;
    const identityOnly = serverInstructions(profiles, owners(['memory', 'identity']), true).length;
    const entitiesOnly = serverInstructions(profiles, owners(['memory', 'entities']), true).length;
    const both = serverInstructions(profiles, owners(['memory', 'identity', 'entities']), true).length;

    // Written as an inequality rather than as four literals, so the assertion
    // survives an edit to the prose while still failing if the collapse is
    // removed — at which point `both` becomes the sum of the two halves.
    expect(both).toBeLessThan(identityOnly + entitiesOnly - neither);
  });

  test('stays inside its budget', () => {
    // This is in the system prompt of every session against this endpoint, so
    // the cost is paid per request forever. The number is arbitrary; needing to
    // raise it is the prompt to ask whether the paragraph belongs in the skill
    // instead, where it is loaded only when relevant.
    expect(text.length).toBeLessThan(MAX_INSTRUCTIONS);
  });

  /**
   * The routing rule, which is the reason `tasks` exists at all.
   *
   * A client told only that memory is worth consulting files "remember to chase
   * the invoice" as a memory entry, where nothing can ever close it. The rule has
   * to be in *this* channel rather than only in the bundled skill, because the
   * client that most needs it is the one holding no skills directory.
   */
  describe('memory and tasks are distinguished, and only when both are there', () => {
    const owners = (bare: readonly string[]) =>
      new Map(
        bare
          .map((id) => `lanes_${id}`)
          .map(
            (id) =>
              [`${id}.list`, reaching({ personal: [`${id}.owner`] })] as [
                string,
                ReturnType<typeof reaching>,
              ],
          ),
      );

    test('both reachable gives one paragraph naming the difference', () => {
      const both = serverInstructions(['personal'], owners(['memory', 'tasks']));

      expect(both).toContain('Memory and tasks are different stores');
      expect(both).toContain('is a task');
      // Not the two singles as well — the pair replaces them.
      expect(both).not.toContain('Memory is worth consulting');
      expect(both).not.toContain('Tasks are what the owner has to do');
    });

    test('memory alone still describes memory, and does not mention tasks', () => {
      const only = serverInstructions(['personal'], owners(['memory']));

      expect(only).toContain('Memory is worth consulting');
      expect(only).not.toContain('different stores');
      // Prose promising a tool the list does not carry is worse than none.
      expect(only).not.toContain('goes in tasks');
    });

    test('tasks alone describes tasks, and does not mention memory', () => {
      const only = serverInstructions(['personal'], owners(['tasks']));

      expect(only).toContain('Tasks are what the owner has to do');
      expect(only).not.toContain('different stores');
      expect(only).not.toContain('Search memory');
    });

    test('assets brings its own paragraph', () => {
      const only = serverInstructions(['personal'], owners(['assets']));

      expect(only).toContain("Assets are the owner's own files");
    });

    test('neither reachable spends nothing on either', () => {
      const none = serverInstructions(['personal'], owners(['setup']));

      expect(none).not.toContain('different stores');
      expect(none).not.toContain('Memory');
      expect(none).not.toContain('tasks');
    });
  });

  /**
   * The budget must not spend itself on prose and leave nothing for the facts.
   *
   * A fully set-up workspace grants all five owner-layer providers, so its prose
   * is the longest there is — and a reserve guessed in advance meant the listing
   * could not fit behind it *at any workspace size*. A single profile with two
   * mailboxes was told "1 profiles" with a hundred characters of the ceiling
   * unspent. The guard is that the small workspace keeps its names.
   */
  test('spends what is left on the facts, not on a reserve', () => {
    const granted = serverInstructions(
      ['personal'],
      new Map([
        ['gmail.send', reaching({ personal: ['gmail.a', 'gmail.b'] })],
        ['lanes_memory.search', reaching({ personal: ['lanes_memory.owner'] })],
        ['lanes_skills.manage.list', reaching({ personal: ['lanes_skills.owner'] })],
        ['lanes_vault.put', reaching({ personal: ['lanes_vault.owner'] })],
        ['lanes_setup.overview', reaching({ personal: ['lanes_setup.main'] })],
      ]),
    );

    expect(granted.length).toBeLessThan(MAX_INSTRUCTIONS);
    // All four habits, and still the accounts by name.
    expect(granted).toContain('Memory is worth consulting');
    expect(granted).toContain('lanes_setup_overview');
    expect(granted).toContain('Reachable now, by profile:');
    expect(granted).toContain('personal: gmail.a, gmail.b');
  });

  test('never degrades to a form longer than the one it rejected', () => {
    // The count form is shorter than naming twenty profiles and longer than
    // naming one, so choosing it unmeasured overran the budget in one direction
    // and wasted it in the other — and printed "1 profiles" doing it.
    for (const count of [1, 2, 5, 20]) {
      const profiles = Array.from({ length: count }, (_, i) => `p${i}`);
      const reachable = new Map(
        profiles.map((profile) => [
          profile,
          Array.from({ length: 30 }, (_, i) => `provider${i}.a_very_long_account_name_${i}`),
        ]),
      );

      const text = serverInstructions(
        profiles,
        new Map([
          ['x.y', { reachable, capability: undefined, discovered: undefined }],
          ['lanes_memory.search', reaching({ [profiles[0] as string]: ['lanes_memory.owner'] })],
          ['lanes_skills.manage.list', reaching({ [profiles[0] as string]: ['lanes_skills.owner'] })],
          ['lanes_vault.put', reaching({ [profiles[0] as string]: ['lanes_vault.owner'] })],
          ['lanes_setup.overview', reaching({ [profiles[0] as string]: ['lanes_setup.main'] })],
        ]),
      );

      expect(text.length).toBeLessThan(MAX_INSTRUCTIONS);
      expect(text).not.toContain('1 profiles');
    }
  });
});

describe('reaching the client', () => {
  test('initialize carries them', async () => {
    const harness = await startStdioHarness({
      profile: 'personal',
      port: allocatePort(),
      policy: `  allow:\n    - "example.*"`,
    });

    try {
      const instructions = harness.client.getInstructions();

      expect(instructions).toBeDefined();
      expect(instructions).toContain('Do not default to whichever is listed first');
      // The generated half, from this harness's own two connections.
      expect(instructions).toContain('personal: example.a, example.b');
    } finally {
      await harness.stop();
    }
  });
});
