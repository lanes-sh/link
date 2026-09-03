import { describe, expect, test } from 'bun:test';
import {
  readState,
  type ConnectionRow,
  type ProviderNames,
  type ReadEndpoint,
} from './state.ts';
import type { ProfileRuntime } from '../mcp/visibility.ts';

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
  { provider: 'gmail', id: 'ada', account: 'ada@example.com', label: 'Work mail' },
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
    const state = readState('local', new Map([['personal', profile(['lanes_memory.main', 'gmail.ada'])]]), ROWS, ENDPOINT);

    expect(state.connections.map((one) => one.ref).sort()).toEqual([
      'gmail.ada',
      'gmail.rin',
      'lanes_memory.main',
    ]);
  });

  test('an ungranted one says so, rather than being absent', () => {
    const state = readState('local', new Map([['personal', profile(['lanes_memory.main'])]]), ROWS, ENDPOINT);
    const rin = state.connections.find((one) => one.ref === 'gmail.rin');

    expect(rin?.profiles).toEqual([]);
  });

  test('carries the label and the account, which are what a reader is shown', () => {
    const state = readState('local', new Map(), ROWS, ENDPOINT, NAMES);
    const ada = state.connections.find((one) => one.ref === 'gmail.ada');

    expect(ada?.label).toBe('Work mail');
    expect(ada?.account).toBe('ada@example.com');
  });

  test('a row with no label is named after its provider and its account', () => {
    // `con8` is what this showed before, which is the one field on a row that
    // says nothing: the id is opaque on purpose. Every reader fell back to it,
    // so a dashboard's whole Label column read as keys.
    const state = readState('local', new Map(), ROWS, ENDPOINT, NAMES);

    expect(state.connections.find((one) => one.ref === 'gmail.rin')?.label).toBe('Gmail (rin)');
  });

  test('a built-in is its proper noun, not its noun twice', () => {
    // The owner layer carries the name in `account` already, so composing the
    // two would read `Memory (Memory)`.
    const state = readState('local', new Map(), ROWS, ENDPOINT, NAMES);

    expect(state.connections.find((one) => one.ref === 'lanes_memory.main')?.label).toBe('Memory');
  });

  test('a provider nothing can name says null rather than guessing', () => {
    // A grant pointing at a connection the workspace no longer holds, and the
    // one row left with nothing to derive a name from.
    const state = readState('local', new Map([['personal', profile(['ghost.one'])]]), ROWS, ENDPOINT, NAMES);

    expect(state.connections.find((one) => one.ref === 'ghost.one')?.label).toBeNull();
  });

  test('with no profiles at all, the workspace still lists what it holds', () => {
    // The state a workspace is in between `connect` and the first `profile add`.
    const state = readState('local', new Map(), ROWS, ENDPOINT);

    expect(state.connections).toHaveLength(3);
    expect(state.profiles).toEqual([]);
  });
});

describe('who can reach one', () => {
  test('names every profile that grants it', () => {
    const state = readState(
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
    const state = readState('local', new Map([['personal', profile(['ghost.one'])]]), ROWS, ENDPOINT);

    expect(state.connections.find((one) => one.ref === 'ghost.one')?.profiles).toEqual([
      'personal',
    ]);
  });
});
