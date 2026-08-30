import { defineProvider, defineProviderWithStrategy } from '#connectivity';
import { BUNQ_HINTS } from './hints.ts';
import { BUNQ_REDACT } from './redact.ts';
import { createBunqStrategy } from './strategy/index.ts';

const specPath = (name: string): string => new URL(`./specs/${name}`, import.meta.url).pathname;

/**
 * bunq — accounts, transaction history, and payments.
 *
 * The one provider here whose authentication is code. Everything else about it
 * is declared like any other manifest, and the eleven operations it can reach
 * come from a vendored OpenAPI document rather than from anything written by
 * hand. What earns the exception is the handshake: bunq generates nothing for
 * you, it wants a keypair you made, an installation, a registered device, and a
 * session, and then it wants every request body signed. No manifest field
 * describes that. See ADR-008 and `./strategy/`.
 *
 * `base_url` carries the version in the **path**, like Sheets and unlike Drive.
 * `https://api.bunq.com` alone 404s on every call.
 *
 * Sandbox is not a second provider and not a flag either: the strategy reads
 * its host from `base_url`, so a manifest in `providers.d/` naming
 * `public-api.sandbox.bunq.com` handshakes and pays there, borrowing this
 * strategy through `strategyFor`. That is where anything touching this should
 * be proven before it is pointed at a real account.
 *
 * No `identity` block, and that is not an omission. The generic HTTP identity
 * probe sends `Authorization: Bearer <token>`, which bunq does not accept and
 * would fail in a way that reads as a bad credential rather than as an
 * inapplicable probe. `connect` asks what to call the connection instead.
 */
const manifest = defineProvider({
  id: 'bunq',
  name: 'bunq',
  description:
    'Bank accounts, balances, transaction history, and payments — including batches and drafts that wait for approval in the bunq app.',
  connector: {
    kind: 'http',
    base_url: 'https://api.bunq.com/v1',
    openapi: specPath('bunq.v1.json'),
  },
  auth: {
    kind: 'strategy',
    strategy: 'bunq',
    // No `credential_ref`, so it derives per connection — `bunq/<id>`. bunq
    // issues one API key per account, and a declared ref would mean every
    // connection sharing one, which is the opposite of true here.
  },
  redact: BUNQ_REDACT,
  hints: BUNQ_HINTS,
  setup: {
    summary:
      'bunq issues an API key from inside the app, not from a web console. The key is bound to the IP addresses ' +
      'it is used from unless you mark it as a wildcard key — which you must do in the app if this endpoint will ' +
      'ever run anywhere but this machine.',
    docs: 'https://lanes.sh/docs/link/bunq',
    docs_url: 'https://doc.bunq.com/basics/authentication/api-keys',
    steps: [
      'In the bunq app: Profile → Security & Settings → Developers → API keys → Add API key.',
      'Name it "Lanes Link", so you can revoke this one later without touching your others.',
      'Set a spending limit on the key while you are there. It is the only bound that does not depend on this software being correct — policy rules and tool lists are ours to get wrong, and a limit at the bank is not.',
      'If this endpoint will run deployed rather than on this machine, mark the key as a wildcard key in the same screen. bunq refuses to set that over the API, deliberately, so it cannot be done for you.',
      'Copy the key and paste it below. Nothing is sent anywhere until you do — the handshake that registers this device runs immediately afterwards.',
      'You will be asked what to call this connection. bunq has no endpoint that reports whose account a key belongs to, so the label is yours to choose.',
      'To try this without a real account first, use bunq\'s sandbox: https://public-api.sandbox.bunq.com issues a test key and needs no bank account at all. Put a manifest of your own in providers.d/ naming that base_url — see https://lanes.sh/docs/link/bunq.',
    ],
    troubleshooting:
      'bunq refused the key. The usual causes are a key that was revoked in the app, a request from an address the key ' +
      'does not permit (mark it as a wildcard key if this runs deployed), or a session that ended because the account\'s ' +
      'auto-logout elapsed — that last one recovers by itself on the next call. Generate a new key in the app and re-run: ' +
      'lanes link connect bunq --replace.',
    prompts: [
      {
        key: 'api_key',
        label: 'bunq API key',
        secret: true,
        scope: 'connection' as const,
      },
    ],
  },
});

export const bunq = defineProviderWithStrategy({
  manifest,
  strategy: createBunqStrategy(),
});
