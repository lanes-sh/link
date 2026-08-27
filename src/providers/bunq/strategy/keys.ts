import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';

/**
 * The signing half of bunq's authentication.
 *
 * bunq is asymmetric where most APIs are not: the client generates a keypair,
 * hands bunq the public half once during installation, and thereafter proves
 * each request by signing it. Nothing here knows what a payment is or which
 * endpoint it is going to — that is the boundary ADR-008 draws around a
 * strategy, and this file is the part of it that is pure arithmetic.
 *
 * **Only the body is signed.** bunq used to require a signature over the whole
 * request — method, path, headers, body — and stopped validating those on 28
 * April 2020. Signing the old way now produces a signature bunq rejects, so
 * getting this wrong fails closed rather than silently: `Sign only the request
 * body (no headers, no URLs)`.
 */

export interface Keypair {
  /** PKCS#8 PEM. Stored, never sent. */
  readonly privateKey: string;
  /** SPKI PEM. This is what `POST /installation` hands over. */
  readonly publicKey: string;
}

/**
 * RSA 2048, which is what bunq's installation endpoint accepts.
 *
 * Generated once per connection at connect time and then persisted, because
 * the public half is registered upstream — a new keypair would mean a new
 * installation, and the old one would keep existing on bunq's side.
 */
export function generateKeypair(): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return { privateKey, publicKey };
}

/**
 * SHA-256 with RSA PKCS#1 v1.5, base64 — the value of `X-Bunq-Client-Signature`.
 *
 * A GET carries no body and signs the empty string, which is a signature bunq
 * accepts and not a reason to omit the header.
 */
export function signBody(body: string, privateKey: string): string {
  return createSign('RSA-SHA256').update(body, 'utf8').sign(privateKey, 'base64');
}

/**
 * Check `X-Bunq-Server-Signature` against the key installation returned.
 *
 * bunq documents this as optional and it is implemented anyway: a strategy that
 * moves money is exactly where the reply being genuinely bunq's is worth
 * establishing, and the seam already carries a `verify` hook for it.
 *
 * Returns a boolean rather than throwing so the caller decides what a mismatch
 * means — which differs between a response that omitted the header entirely and
 * one that carried a wrong signature.
 */
export function verifyBody(body: string, signature: string, publicKey: string): boolean {
  try {
    return createVerify('RSA-SHA256').update(body, 'utf8').verify(publicKey, signature, 'base64');
  } catch {
    // A malformed key or a signature that is not base64. Indistinguishable from
    // a wrong signature as far as the caller is concerned, and both are refusals.
    return false;
  }
}
