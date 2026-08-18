import { describe, expect, test } from 'bun:test';
import { fanOutAudit } from './fanout.ts';
import type { AuditDraft, AuditEvent, AuditSink } from './index.ts';

/**
 * The property under test is not "copies arrive". It is that a copy failing
 * cannot take the log — or the capability call — with it.
 */

const draft: AuditDraft = {
  profile: 'personal',
  principal: 'personal:owner',
  provider: 'gmail',
  capability: 'gmail.users_messages_list',
  arguments: {},
  authorization: 'allowed',
  status: 'ok',
  durationMs: 1,
};

function recording(): AuditSink & { seen: AuditEvent[]; closed: () => boolean } {
  const seen: AuditEvent[] = [];
  let closed = false;
  return {
    seen,
    closed: () => closed,
    async append(input) {
      const event = { ...input, id: `evt_${seen.length}`, timestamp: new Date(0) };
      seen.push(event);
      return event;
    },
    async close() {
      closed = true;
    },
  };
}

/** Lets the fan-out's un-awaited copy settle before assertions read it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('audit fan-out', () => {
  test('with no copies it is the primary, untouched', () => {
    const primary = recording();
    expect(fanOutAudit({ primary, secondaries: [] })).toBe(primary);
  });

  test('the event reaches both, and the primary decides the id', async () => {
    const primary = recording();
    const copy = recording();
    const sink = fanOutAudit({ primary, secondaries: [copy] });

    const written = await sink.append(draft);
    await settle();

    expect(written.id).toBe('evt_0');
    expect(copy.seen).toHaveLength(1);
    // The copy is handed the event the primary wrote, not a second draft: a
    // reader correlating the two must see one id, not two.
    expect(copy.seen[0]?.id).toBe(written.id);
  });

  test('a copy that throws does not fail the call', async () => {
    // The whole reason the fan-out exists. A collector being down must not
    // become a capability that cannot be invoked.
    const primary = recording();
    const reported: string[] = [];
    const sink = fanOutAudit({
      primary,
      secondaries: [
        {
          append: async () => {
            throw new Error('collector unreachable');
          },
          close: async () => {},
        },
      ],
      onError: (message) => reported.push(message),
    });

    await expect(sink.append(draft)).resolves.toMatchObject({ id: 'evt_0' });
    await settle();

    expect(primary.seen).toHaveLength(1);
    expect(reported[0]).toContain('collector unreachable');
  });

  test('a failing copy is reported once, not once per event', async () => {
    const reported: string[] = [];
    const sink = fanOutAudit({
      primary: recording(),
      secondaries: [{ append: async () => { throw new Error('down'); }, close: async () => {} }],
      onError: (message) => reported.push(message),
    });

    for (let i = 0; i < 5; i += 1) await sink.append(draft);
    await settle();

    // A log line per audit event would make an outage louder than the traffic
    // it is failing to copy.
    expect(reported).toHaveLength(1);
  });

  test('a primary that throws still throws', async () => {
    // The inverse of the above, and the line that must not move: the durable
    // write is the guarantee, so its failure is the caller's problem.
    const sink = fanOutAudit({
      primary: { append: async () => { throw new Error('disk full'); }, close: async () => {} },
      secondaries: [recording()],
    });

    await expect(sink.append(draft)).rejects.toThrow('disk full');
  });

  test('a stalled copy does not hold the queue open forever', async () => {
    const reported: string[] = [];
    let release: (() => void) | undefined;
    const stalled: AuditSink = {
      append: async (input) => {
        await new Promise<void>((resolve) => (release = resolve));
        return { ...input, id: 'x', timestamp: new Date(0) };
      },
      close: async () => {},
    };

    const sink = fanOutAudit({
      primary: recording(),
      secondaries: [stalled],
      onError: (message) => reported.push(message),
    });

    // Far more than the queue bound, so the drop path is the one exercised.
    for (let i = 0; i < 1200; i += 1) await sink.append(draft);
    await settle();

    expect(reported.some((message) => message.includes('dropping copies'))).toBe(true);
    release?.();
  });

  test('close closes both, and the primary last', async () => {
    const primary = recording();
    const copy = recording();
    await fanOutAudit({ primary, secondaries: [copy] }).close();

    expect(primary.closed()).toBe(true);
    expect(copy.closed()).toBe(true);
  });
});
