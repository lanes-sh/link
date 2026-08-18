/**
 * The escape hatch: auth no declarative form should try to express.
 *
 * bunq generates an RSA keypair, runs a three-step handshake, signs every
 * request, and verifies the response signature. That earns code. Nothing is
 * registered yet, so this fails loudly rather than sending an unauthenticated
 * request that would fail confusingly upstream.
 */
export function refuseStrategy(strategy: string): never {
  throw new Error(
    `Auth strategy "${strategy}" is not registered. ` +
      `Strategies are the only place per-vendor code belongs; see docs/detailed/creating-a-provider.md.`,
  );
}
