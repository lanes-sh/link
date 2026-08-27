import { describe, expect, test } from 'bun:test';
import { generateKeypair, signBody, verifyBody } from './keys.ts';

const keys = generateKeypair();

describe('generateKeypair', () => {
  test('produces the PEM shapes bunq and node each expect', () => {
    expect(keys.publicKey).toStartWith('-----BEGIN PUBLIC KEY-----');
    expect(keys.privateKey).toStartWith('-----BEGIN PRIVATE KEY-----');
  });

  test('is a fresh pair each time, so one connection cannot sign for another', () => {
    expect(generateKeypair().privateKey).not.toBe(keys.privateKey);
  });
});

describe('signBody', () => {
  test('round-trips against the public half', () => {
    const body = JSON.stringify({ amount: { value: '10.00', currency: 'EUR' } });

    expect(verifyBody(body, signBody(body, keys.privateKey), keys.publicKey)).toBe(true);
  });

  test('a changed body no longer verifies — the point of signing it', () => {
    const signature = signBody('{"value":"10.00"}', keys.privateKey);

    expect(verifyBody('{"value":"1000.00"}', signature, keys.publicKey)).toBe(false);
  });

  test('an empty body signs and verifies, which is what a GET sends', () => {
    expect(verifyBody('', signBody('', keys.privateKey), keys.publicKey)).toBe(true);
  });

  test('another keypair cannot produce an accepted signature', () => {
    const other = generateKeypair();

    expect(verifyBody('body', signBody('body', other.privateKey), keys.publicKey)).toBe(false);
  });

  test('the signature is base64, which is what the header carries', () => {
    expect(signBody('body', keys.privateKey)).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('verifyBody', () => {
  test('a malformed signature is a refusal rather than a throw', () => {
    expect(verifyBody('body', 'not base64 at all !!', keys.publicKey)).toBe(false);
  });

  test('a malformed key is a refusal rather than a throw', () => {
    expect(verifyBody('body', signBody('body', keys.privateKey), 'not a key')).toBe(false);
  });
});
