import { credentialRefForConnection, strategyContextFrom, strategyFor } from '#connectivity';
import type { ProviderManifest } from '#connectivity';
import { createScopedStore, scopeNamespace } from '#dispatch';
import { scopeSecrets } from '#secrets';
import type { SecretStore } from '#secrets';
import type { RuntimeState } from '#stores/state';
import type { ProviderRegistry } from '#registry';
import { progress, style } from '../../output.ts';

/**
 * The handshake a strategy provider needs before it can be called at all.
 *
 * Ordinary providers finish authenticating the moment the operator pastes
 * something: the value *is* the credential. A strategy provider has only half
 * of one at that point — bunq's API key is the input to an installation, not a
 * token — so this runs the vendor's own setup between storing what was pasted
 * and asking whose account it is.
 *
 * **Why it sits where it does in `connect`.** After the credential is stored,
 * because the handshake's input is what was pasted. Before identity is settled
 * and anything is written to the config, because a key the vendor rejects
 * should fail here — with the vendor's own message — rather than leaving a
 * connection row describing an account that cannot be reached. It runs under
 * the *provisional* connection id for the same reason every other step does:
 * the real one is not known yet, and `connect` moves the credential when it is.
 *
 * Here rather than in `index.ts` because that file is at its size budget, and
 * because this is one self-contained step: everything it needs is a manifest
 * and a runtime, and everything it produces is in the credential store.
 */
export async function runStrategySetup(
  manifest: ProviderManifest,
  /** The provisional id. `connect` renames the connection afterwards and the credential follows. */
  connectionId: string,
  /** Structurally the CLI `Runtime`, named as the parts this actually reaches. */
  runtime: {
    readonly registry: ProviderRegistry;
    readonly credentials: SecretStore;
    readonly state: RuntimeState;
    readonly resolution: { readonly profile: string };
  },
): Promise<void> {
  const { registry, credentials, state } = runtime;
  const profile = runtime.resolution.profile;
  if (manifest.auth.kind !== 'strategy') return;

  const strategy = strategyFor(manifest, registry);
  if (!strategy.setup) return;

  // The one ref this connection may read, which is also the one the pasted
  // value landed in and the one the handshake will rewrite.
  const ref = credentialRefForConnection(manifest, connectionId)!;

  const context = strategyContextFrom({
    source: {
      credentials: scopeSecrets(credentials, [ref]),
      state: createScopedStore(state, scopeNamespace(manifest.id, connectionId)),
      log: {
        debug: () => {},
        info: (message) => progress(style.dim(`  ${message}`)),
        warn: (message) => progress(style.dim(`  ${message}`)),
        error: (message) => progress(style.dim(`  ${message}`)),
      },
    },
    manifest,
    connectionId,
    profile,
    // Writable *only* here — the dispatch path passes nothing, so a per-request
    // handshake cannot persist anything.
    //
    // Scoped to the same single ref the reads are. Handing over the raw store
    // would leave the write side of this boundary open while the read side is
    // shut, which is the asymmetry that makes a boundary decorative: a strategy
    // could not *read* `google/main` and could quietly overwrite it.
    write: async (reference, value) => {
      if (reference !== ref) {
        throw new Error(
          `The ${manifest.name} strategy tried to write ${reference}, which is not its connection's credential (${ref}).`,
        );
      }
      await credentials.set(reference, value);
    },
  });

  progress(style.dim(`  Registering this device with ${manifest.name}…`));
  await strategy.setup(context);
}
