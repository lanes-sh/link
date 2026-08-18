/**
 * Runtime state over an in-memory blob store, for tests.
 *
 * Note what this is *not*: a second implementation. It is the real
 * `createRuntimeState` over `createMemoryBlobStore`, so a test cannot
 * demonstrate behaviour the shipped code does not have — which is what the
 * hand-written in-memory `RuntimeState` beside it used to risk, and did: its
 * `list()` returned insertion order where both SQL adapters sorted.
 *
 * Kept behind a separate entry point anyway, so application code cannot reach
 * the memory store by accident.
 */

import { createMemoryBlobStore } from '../blobs/testing.ts';
import { createRuntimeState, type RuntimeState } from './index.ts';

export function createMemoryState(now: () => Date = () => new Date()): RuntimeState {
  return createRuntimeState(createMemoryBlobStore(), now);
}

/** An in-memory credential store, for the same reason. */
export function createMemoryCredentials(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async get(ref: string) {
      return map.get(ref) ?? null;
    },
    async set(ref: string, value: string) {
      map.set(ref, value);
    },
    async has(ref: string) {
      return map.has(ref);
    },
    async delete(ref: string) {
      map.delete(ref);
    },
    async list(prefix?: string) {
      return [...map.keys()].filter((k) => !prefix || k.startsWith(prefix));
    },
  };
}
