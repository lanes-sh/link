import { describe, expect, test } from 'bun:test';
import { ownerPrincipal } from '#auth';
import { toPolicyDocument } from '#registry';
import { parseConfig } from '#profile';
import { SURFACE_TOOL_NAMES } from './naming.ts';
import { oneProfile, visibleCapabilities, visibleToolCount } from './visibility.ts';
import type { BuildServerOptions, ProfileRuntime } from './visibility.ts';

/**
 * That a granted account with no credential is still advertised.
 *
 * This is the property `lanes link connection declare` is built on, and it had
 * no test — so the thing that makes a client's tool list hold still was resting
 * on an implementation detail nobody had written down (ADR-075).
 *
 * The detail is that `connectionsOf` reads `config.grants` and consults nothing
 * else. Not `ConnectionStatus`, not the credential store, not the state record
 * that `reconcile` writes — because the grant row *is* the grant (ADR-058). So a
 * connection whose credential is missing is advertised exactly like one whose
 * credential is present, and the refusal happens on the call instead
 * (`dispatch.ts`, `denied_connection_unauthorized`).
 *
 * It reads like an oversight and it is the opposite. Filtering discovery on
 * whether a credential exists would mean the advertised list changed the moment
 * an account was authorised — which is the moment an operator is least placed to
 * also go and refresh a client, and the whole of issue #162. Keeping it out of
 * discovery is what lets the two events separate.
 *
 * Worth pinning rather than trusting, because the opposite is such a reasonable
 * thing to implement. "Do not advertise what cannot be called" is a sentence
 * somebody will write while tidying up, it would pass every other test here,
 * and what it breaks is not visible from anywhere in this file's neighbourhood.
 */

/** One discovered tool, of the shape an `http` provider's connector yields. */
const discovered = (name: string) => ({
  name,
  title: `Vendor Mail: ${name}`,
  description: 'Does a thing.',
  inputSchema: { type: 'object', properties: {} },
});

/**
 * A profile granting one account of one provider.
 *
 * The registry is faked rather than built, because what is under test is what
 * `mergeCapabilities` does with grants — and a real registry would drag a
 * workspace, a state store and a credential store in to answer a question about
 * neither. There is deliberately no credential anywhere in this fixture: that is
 * the case being asserted.
 */
function profileGranting(connection: string, capabilities: readonly string[]): BuildServerOptions {
  const { config } = parseConfig(`
contract: 5
instance:
  profile: personal
  port: 7300
grants:
  - connection: ${connection}
    allow: ["${connection.split('.')[0]}.*"]
    deny: []
members: []
`);

  const runtime = {
    config,
    registry: {
      capabilities: () =>
        capabilities.map((id) => ({
          id,
          capability: undefined,
          discovered: discovered(id.slice(id.indexOf('.') + 1)),
        })),
    },
    policy: toPolicyDocument(config),
  } as unknown as ProfileRuntime;

  return {
    profiles: oneProfile('personal', runtime),
    principal: ownerPrincipal('personal'),
  } as unknown as BuildServerOptions;
}

describe('a declared account with no credential', () => {
  const options = profileGranting('vendor_mail.main', [
    'vendor_mail.messages.list',
    'vendor_mail.messages.get',
  ]);

  test('is advertised, credential or not', () => {
    expect(visibleCapabilities(options).sort()).toEqual([
      'vendor_mail.messages.get',
      'vendor_mail.messages.list',
    ]);
  });

  test('counts toward what tools/list carries', () => {
    // Written as the arithmetic rather than as `4`, because the number is two
    // separate claims: the capabilities the grant makes reachable, and the
    // stable-name pair that is advertised whatever policy says (ADR-075).
    expect(visibleToolCount(options)).toBe(2 + SURFACE_TOOL_NAMES.length);
  });

  /**
   * The other half of the same rule, and the reason the one above is safe: a
   * connection the profile does not grant is absent, so "advertised without a
   * credential" is not "advertised without a grant". Default deny is untouched
   * (ADR-058) — the grant row is doing the work, and it is the only thing that
   * is.
   */
  test('but an account nothing grants is not advertised', () => {
    const ungranted = profileGranting('vendor_mail.main', ['vendor_chat.messages.list']);

    expect(visibleCapabilities(ungranted)).toEqual([]);
    // No capability, and therefore only the pair — which reaches nothing,
    // because it can only reach what is in the merged set.
    expect(visibleToolCount(ungranted)).toBe(SURFACE_TOOL_NAMES.length);
  });
});
