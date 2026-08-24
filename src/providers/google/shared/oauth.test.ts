import { describe, expect, test } from 'bun:test';
import { GOOGLE_BROKER, GOOGLE_OAUTH, googleBroker } from './oauth.ts';

describe('googleBroker', () => {
  test('points at the client Lanes operates when nothing overrides it', () => {
    expect(googleBroker({}).url).toBe('https://api.lanes.sh/v1/auth/link/google');
    expect(GOOGLE_BROKER.url).toBe('https://api.lanes.sh/v1/auth/link/google');
  });

  test('moves the origin and keeps the path', () => {
    // The path is this provider's; only the host holding the secret moves.
    expect(googleBroker({ LANES_LINK_BROKER_ORIGIN: 'http://127.0.0.1:8080' }).url).toBe(
      'http://127.0.0.1:8080/v1/auth/link/google',
    );
  });

  test('names its operator either way, because consent says who it is', () => {
    expect(googleBroker({}).operator).toBe('Lanes');
    expect(googleBroker({ LANES_LINK_BROKER_ORIGIN: 'https://stage.example.com' }).operator).toBe(
      'Lanes',
    );
  });

  test('is what every REST provider spreads, so one switch moves all of them', () => {
    expect(GOOGLE_OAUTH.broker).toBe(GOOGLE_BROKER);
  });
});
