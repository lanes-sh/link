import { RESERVED_PROVIDER_IDS } from '#connectivity';

/**
 * What this endpoint says about how its tools behave.
 *
 * Its own file because it is a claim to the outside rather than a detail of how
 * the surface is assembled, and because the direction of each claim is an
 * argument that wants somewhere to live.
 */

/** Whether a capability belongs to the owner layer — the endpoint's own material. */
function isOwnerLayer(id: string): boolean {
  const [provider] = id.split('.');
  return provider !== undefined && (RESERVED_PROVIDER_IDS as readonly string[]).includes(provider);
}

/**
 * What this endpoint is willing to say about how a tool behaves.
 *
 * The four hints the protocol defines, and the reason for saying any of them:
 * a client that knows a tool only reads can stop asking permission to read.
 * Today it cannot know, because nothing here says — so a client's "allow
 * low-risk actions" setting finds nothing low-risk on this endpoint, and
 * fetching a file the owner stored themselves needs a human click. That is a
 * round trip through a person, on every call, and it is slower than anything
 * the network does.
 *
 * The direction of every claim is chosen so that being wrong is expensive
 * rather than dangerous. `readOnlyHint` comes from the provider's own bundle,
 * which is what policy already enforces with. The other three are only claimed
 * in the safe direction: a read is stated to be non-destructive and idempotent
 * because it certainly is; a write is stated to be destructive because it might
 * be, and over-claiming costs a confirmation nobody needed while under-claiming
 * skips one that was.
 *
 * None of this is enforcement, and the specification is explicit that clients
 * must treat hints from an untrusted server as untrusted. `evaluate` remains
 * the only thing that decides what may be called.
 */
export function annotationsFor(
  id: string,
  reads: boolean,
): { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } {
  return {
    readOnlyHint: reads,
    destructiveHint: !reads,
    idempotentHint: reads,
    // The owner layer is this endpoint's own material — memory, tasks, files it
    // holds — so it is a closed domain. Everything else reaches somebody else's
    // service, which is what the hint is for.
    openWorldHint: !isOwnerLayer(id),
  };
}
