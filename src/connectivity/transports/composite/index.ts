import {
  type AnyConnector,
  type CapabilityResult,
  type ConnectorContext,
  type DiscoveredCapability,
  type DiscoveryContext,
  type ProviderDefinition,
} from '#connectivity';
import { createLocalConnector } from '../local/index.ts';

/**
 * A remote connector with a few capabilities of our own on top.
 *
 * Every provider picks one connectivity kind, and that has held for every
 * provider so far: a manifest describes how to reach a service and the service
 * describes what it offers. It stops holding when the vendor's API can do
 * something its *document* cannot express. A mail API is the case in hand — it
 * accepts a whole assembled RFC 2822 message as one base64 field, and nothing in
 * an OpenAPI document says "compose MIME from these parts". The generated tool
 * therefore obliges the caller to build the message, which for anything with an
 * attachment means emitting the file as base64 into the conversation. That is the
 * problem this exists to remove.
 *
 * Three alternatives were considered and are worse:
 *
 * - **Teach the HTTP transport to compose mail.** It is the generic transport;
 *   mail knowledge in it is vendor knowledge in shared code, which
 *   `architecture.test.ts` refuses on purpose.
 * - **A second provider holding just the authored capability.** It would need its
 *   own connection, so one mailbox would appear twice, consent and identity
 *   labelling would split, and a policy rule would have to name both.
 * - **Reach the other provider's credential from a handler.** `ProviderContext`
 *   says plainly that a provider cannot reach another connection, and that is
 *   worth more than this feature.
 *
 * So: the definition's capabilities are answered here, everything else is
 * delegated. `discover` delegates untouched, because authored capabilities come
 * from the definition and must not be written into the discovery cache — they are
 * code, and caching them would let a stale row outlive a rename.
 */
export function createCompositeConnector(input: {
  readonly definition: ProviderDefinition;
  readonly remote: AnyConnector;
}): AnyConnector {
  const { definition, remote } = input;
  const authored = createLocalConnector(definition);
  const names = new Set(definition.capabilities.map((capability) => capability.name));

  return {
    // The remote kind, because that is what this connection *is*: `doctor`,
    // `provider list` and the setup walkthrough all describe how the account is
    // reached, and "composite" would answer a question nobody asked.
    kind: remote.kind,

    async discover(context: DiscoveryContext): Promise<DiscoveredCapability[]> {
      return remote.discover(context);
    },

    async invoke(capability, args, context: ConnectorContext): Promise<CapabilityResult> {
      return names.has(capability.name)
        ? authored.invoke(capability, args, context)
        : remote.invoke(capability, args, context);
    },

    ...(remote.identify ? { identify: (): Promise<string | null> => remote.identify!() } : {}),
    ...(remote.close ? { close: (): Promise<void> => remote.close!() } : {}),
  };
}
