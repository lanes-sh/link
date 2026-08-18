import type { ResolvedCredential } from '../credential.ts';

/**
 * No credential at all.
 *
 * Not an absence to be handled everywhere — a method like any other, so the
 * `fs` and `local` transports go down the same path as Gmail and the callers
 * never branch on "is there auth".
 */
export function resolveNone(): ResolvedCredential {
  return { kind: 'none' };
}
