import { describe, expect, test } from 'bun:test';
import {
  readState,
  type ConnectionRow,
  type ProviderNames,
  type ReadEndpoint,
} from './state.ts';
import type { ProfileRuntime } from '../mcp/visibility.ts';
import type { PairedCaller } from './session.ts';

/**
 * `readState` for somebody every profile in the map names.
 *
 * The cases below are about which rows exist rather than about who is asking,
 * and they predate the caller argument. Routing them through one wrapper keeps
 * them reading as they did; the filtering itself is tested at the bottom of
 * this file, where the caller is the subject.
 */
function stateFor(
  workspace: string,
  profiles: ReadonlyMap<string, ProfileRuntime>,
  rows: readonly ConnectionRow[],
  endpoint: ReadEndpoint,
  names?: ProviderNames,
) {
  const caller: PairedCaller = { subject: 'lanes:HER', profiles: [...profiles.keys()] };
  return readState(workspace, profiles, rows, endpoint, caller, names);
}

/**
 * What the dashboard is told the workspace holds.
 *
 * One property carries this file: **the workspace's connection list decides
 * which connections exist, and the grants decide only who can reach them.**
 * Deriving the list from the grants instead made an account that no profile
 * grants invisible — which is exactly the state `lanes link connect` leaves one
 * in when it is run without `--profile`, so a freshly authorised account did
 * not appear at all.
 */

const ROWS: ConnectionRow[] = [
  { provider: 'lanes_memory', id: 'main', account: 'Memory' },
  {
    provider: 'gmail',
    id: 'ada',
    account: 'ada@example.com',
    label: 'Work mail',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-03-04T05:06:07.000Z',
  },
  // No dates: a row the state store has not caught up with, which is the
  // ordinary case for a connection added since the last reconcile pass.
  { provider: 'gmail', id: 'rin', account: 'rin@example.com' },
];

/**
 * What the two providers in `ROWS` are called, as a registry would say.
 *
 * A closure rather than the real registry: `readState` takes the lookup because
 * the read surface may not import the catalogue, and a test supplying two names
 * exercises the same path a bind does.
 */
const NAMES: ProviderNames = (provider) =>
  ({ gmail: 'Gmail', lanes_memory: 'Memory' })[provider];

/** What the bind says about itself. Fixed for a test about which rows exist. */
const ENDPOINT: ReadEndpoint = {
  kind: 'local',
  version: '0.0.0-test',
  certificateExpiresAt: null,
};

/** A profile runtime with only what `readState` reads. */
function profile(grants: string[]): ProfileRuntime {
  return {
    config: {
      description: 'A profile',
      grants: grants.map((connection) => ({ connection, allow: [], deny: [] })),
      members: [{ subject: 'lanes:HER', role: 'owner' }],
    },
    // Empty, so `reachable` is empty everywhere and the capability axis stays
    // out of a test about which rows exist.
    registry: { capabilities: () => [] },
    policy: { byConnection: new Map() },
  } as unknown as ProfileRuntime;
}

describe('which connections exist', () => {
  test('every one the workspace holds, granted or not', () => {
    // The bug this file exists for. `gmail.rin` is authorised and no profile
    // grants it; it is still a connection, and a dashboard that hid it would be
    // telling somebody their `connect` did nothing.
    const state = stateFor('local', new Map([['personal', profile(['lanes_memory.main', 'gmail.ada'])]]), ROWS, ENDPOINT);

    expect(state.connections.map((one) => one.ref).sort()).toEqual([
      'gmail.ada',
      'gmail.rin',
      'lanes_memory.main',
    ]);
  });

  test('an ungranted one says so, rather than being absent', () => {
    const state = stateFor('local', new Map([['personal', profile(['lanes_memory.main'])]]), ROWS, ENDPOINT);
    const rin = state.connections.find((one) => one.ref === 'gmail.rin');

    expect(rin?.profiles).toEqual([]);
  });

  test('carries the label and the account, which are what a reader is shown', () => {
    const state = stateFor('local', new Map(), ROWS, ENDPOINT, NAMES);
    const ada = state.connections.find((one) => one.ref === 'gmail.ada');

    expect(ada?.label).toBe('Work mail');
    expect(ada?.account).toBe('ada@example.com');
  });

  test('a row with no label is named after its provider and its account', () => {
    // `con8` is what this showed before, which is the one field on a row that
    // says nothing: the id is opaque on purpose. Every reader fell back to it,
    // so a dashboard's whole Label column read as keys.
    const state = stateFor('local', new Map(), ROWS, ENDPOINT, NAMES);

    expect(state.connections.find((one) => one.ref === 'gmail.rin')?.label).toBe('Gmail (rin)');
  });

  test('a built-in is its proper noun, not its noun twice', () => {
    // The owner layer carries the name in `account` already, so composing the
    // two would read `Memory (Memory)`.
    const state = stateFor('local', new Map(), ROWS, ENDPOINT, NAMES);

    expect(state.connections.find((one) => one.ref === 'lanes_memory.main')?.label).toBe('Memory');
  });

  test('a provider nothing can name says null rather than guessing', () => {
    // A grant pointing at a connection the workspace no longer holds, and the
    // one row left with nothing to derive a name from.
    const state = stateFor('local', new Map([['personal', profile(['ghost.one'])]]), ROWS, ENDPOINT, NAMES);

    expect(state.connections.find((one) => one.ref === 'ghost.one')?.label).toBeNull();
  });

  test('with no profiles at all, the workspace still lists what it holds', () => {
    // The state a workspace is in between `connect` and the first `profile add`.
    const state = stateFor('local', new Map(), ROWS, ENDPOINT);

    expect(state.connections).toHaveLength(3);
    expect(state.profiles).toEqual([]);
  });
});

describe('who can reach one', () => {
  test('names every profile that grants it', () => {
    const state = stateFor(
      'local',
      new Map([
        ['personal', profile(['gmail.ada'])],
        ['work', profile(['gmail.ada'])],
      ]),
      ROWS,
      ENDPOINT,
    );

    expect([...(state.connections.find((one) => one.ref === 'gmail.ada')?.profiles ?? [])].sort()).toEqual([
      'personal',
      'work',
    ]);
  });

  test('a grant naming a connection the workspace does not hold still appears', () => {
    // `assertGrantsResolve` refuses this at load, so it is unreachable through
    // the CLI. The read surface describes what is there rather than assuming,
    // because a row that appeared only in a grant would otherwise vanish from
    // the listing while still governing a profile.
    const state = stateFor('local', new Map([['personal', profile(['ghost.one'])]]), ROWS, ENDPOINT);

    expect(state.connections.find((one) => one.ref === 'ghost.one')?.profiles).toEqual([
      'personal',
    ]);
  });
});

/**
 * When a connection arrived, and when it last moved.
 *
 * `connections.yaml` has never carried a date, so these come from the state
 * store and `connectionRows` attaches them. Two things matter here: a row the
 * store has no record of still appears, and the row nothing holds but a grant
 * says null rather than borrowing a date from somewhere else.
 */
describe('when a connection arrived', () => {
  test('the dates the store had are passed through', () => {
    const state = stateFor('acme', new Map(), ROWS, ENDPOINT, NAMES);
    const ada = state.connections.find((one) => one.ref === 'gmail.ada');

    expect(ada?.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(ada?.updatedAt).toBe('2026-03-04T05:06:07.000Z');
  });

  test('a row the store has no record of is still listed, and says so', () => {
    // The state store is rebuilt from the file and can be deleted at any time.
    // Missing dates must cost a reader the dates, never the row.
    const state = stateFor('acme', new Map(), ROWS, ENDPOINT, NAMES);
    const rin = state.connections.find((one) => one.ref === 'gmail.rin');

    expect(rin).toBeDefined();
    expect(rin?.createdAt).toBeNull();
    expect(rin?.updatedAt).toBeNull();
  });

  test('a grant naming a connection the workspace no longer holds has no dates', () => {
    const profiles = new Map([['personal', profile(['slack.vanished'])]]);
    const state = stateFor('acme', profiles, ROWS, ENDPOINT, NAMES);
    const orphan = state.connections.find((one) => one.ref === 'slack.vanished');

    expect(orphan).toBeDefined();
    expect(orphan?.createdAt).toBeNull();
    expect(orphan?.updatedAt).toBeNull();
  });
});

/**
 * Who is asking, which is what this surface never used to ask.
 *
 * `/state` was gated on holding the workspace's pairing token and then
 * described every profile the endpoint served, each with its `members:` roster
 * and every capability its grants reached. A workspace member on no profile
 * read all of it. These are the cases that would have caught that (ADR-079).
 */
describe('what one caller is told the workspace holds', () => {
  const TWO = new Map([
    ['personal', profile(['lanes_memory.main'])],
    ['work', profile(['gmail.ada'])],
  ]);

  const asking = (...profiles: string[]): PairedCaller => ({ subject: 'lanes:HER', profiles });

  test('only the profiles that name them', () => {
    const state = readState('local', TWO, ROWS, ENDPOINT, asking('personal'));

    expect(state.profiles.map((one) => one.name)).toEqual(['personal']);
  });

  test('a profile they are on carries its roster; one they are not carries nothing', () => {
    // The roster is not withheld from a profile they reach: reaching it *is*
    // being on it, so the list is their own team. What must not happen is
    // learning the roster of a profile that does not name them, and the way
    // that is prevented is that the profile is not described at all.
    const state = readState('local', TWO, ROWS, ENDPOINT, asking('personal'));

    expect(state.profiles[0]?.members).toEqual([{ subject: 'lanes:HER', role: 'owner' }]);
    expect(state.profiles.some((one) => one.name === 'work')).toBe(false);
  });

  test('a member of nothing is told nothing, connections included', () => {
    // Signing in successfully and reaching nothing is a normal outcome. What
    // it must not do is describe the workspace: a connection row carries an
    // account name, and this caller has proved only that they signed in.
    const state = readState('local', TWO, ROWS, ENDPOINT, asking());

    expect(state.profiles).toEqual([]);
    expect(state.connections).toEqual([]);
  });

  test('a connection names only the profiles this caller can see it through', () => {
    // `profiles` on a row is what the dashboard shows as "granted to". Left
    // unfiltered it would name a profile the caller cannot reach, which is the
    // existence of that profile leaking through a list they are entitled to.
    const state = readState('local', TWO, ROWS, ENDPOINT, asking('personal'));
    const gmail = state.connections.find((one) => one.ref === 'gmail.ada');

    expect(gmail?.profiles).toEqual([]);
  });

  test('a workspace with no profiles at all still lists what it holds', () => {
    // Not a boundary being enforced: there is nothing to be a member of yet.
    // An empty answer here would be `lanes link connect` run without
    // `--profile` looking like it did nothing.
    const state = readState('local', new Map(), ROWS, ENDPOINT, asking());

    expect(state.connections.map((one) => one.ref).sort()).toEqual([
      'gmail.ada',
      'gmail.rin',
      'lanes_memory.main',
    ]);
  });
});
