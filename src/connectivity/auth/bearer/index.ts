import type { ResolvedCredential } from '../credential.ts';

/** A long-lived token the operator pasted in, sent as `Bearer <token>`. */
export function resolveBearer(value: string, header: string | undefined): ResolvedCredential {
  return { kind: 'bearer', token: value, header: header ?? 'authorization' };
}

export function attachBearer(
  credential: Extract<ResolvedCredential, { kind: 'bearer' }>,
  request: Request,
): void {
  request.headers.set(credential.header, `Bearer ${credential.token}`);
}
