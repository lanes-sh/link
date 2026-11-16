import type { AuditDraft, AuditStore } from './index.ts';

/**
 * The fixture half of the audit conformance suite.
 *
 * Split out when the suite outgrew the file-size budget, which it did by
 * gaining the query cases it had been missing. Two files consume these now —
 * the suite itself and `./conformance-query.ts` — so the row builder and the
 * clock live where both reach them rather than being threaded through as
 * parameters.
 */
export interface ContractSink {
  open(options?: { now?: () => Date; run?: string }): AuditStore;
  keys(): Promise<string[]>;
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  dispose?(): Promise<void>;
}

export function draft(overrides: Partial<AuditDraft> = {}): AuditDraft {
  return {
    profile: 'personal',
    principal: 'personal:owner',
    provider: 'gmail',
    connection: 'gmail.main',
    capability: 'gmail.users_messages_list',
    arguments: { q: '<string:12>' },
    authorization: 'allowed',
    status: 'ok',
    durationMs: 12,
    ...overrides,
  };
}

/** A clock that advances a second per call, so ordering is deterministic. */
export function ticking(start = Date.UTC(2026, 7, 12, 10, 0, 0)): () => Date {
  let at = start;
  return () => {
    at += 1000;
    return new Date(at);
  };
}

