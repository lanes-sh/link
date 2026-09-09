/**
 * Harvest the real capability surface, offline, from what the repository holds.
 *
 * Every provider whose manifest carries an OpenAPI document is discovered the
 * same way the endpoint discovers it, and the owner layer is read from its own
 * declarations — so the text is the vendor's own rather than a fixture author's.
 * Nothing here opens a connection or reads a credential.
 */
import { createHttpConnector } from '#connectivity/transports';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import { memoryProvider, tasksProvider, assetsProvider, entitiesProvider } from '#providers/owner.ts';

type Row = {
  provider: string;
  keywords: string[];
  providerDescription: string;
  name: string;
  title: string | undefined;
  description: string;
  schemaBytes: number;
  properties: string[];
  required: string[];
};

const out: Row[] = [];

for (const manifest of PROVIDER_MANIFESTS) {
  if (manifest.connector.kind !== 'http') continue;
  const connector = manifest.connector as { base_url: string; openapi: string };
  const capabilities = await createHttpConnector({
    baseUrl: connector.base_url,
    openapi: connector.openapi,
  }).discover({ manifest });

  for (const capability of capabilities) {
    out.push({
      provider: manifest.id,
      keywords: [...((manifest as { keywords?: string[] }).keywords ?? [])],
      providerDescription: String((manifest as { description?: string }).description ?? ''),
      name: capability.name,
      title: capability.title,
      description: capability.description,
      schemaBytes: JSON.stringify(capability.inputSchema).length,
      properties: Object.keys((capability.inputSchema['properties'] ?? {}) as object),
      required: [...((capability.inputSchema['required'] ?? []) as string[])],
    });
  }
  console.error(`${manifest.id}: ${capabilities.length}`);
}

for (const provider of [memoryProvider, tasksProvider, assetsProvider, entitiesProvider]) {
  const declared = provider as unknown as {
    manifest: { id: string; keywords?: string[]; description?: string };
    capabilities: { name: string; title?: string; description: string; inputSchema?: unknown }[];
  };
  const about = declared.manifest;
  for (const capability of declared.capabilities ?? []) {
    out.push({
      provider: about.id,
      keywords: [...(about.keywords ?? [])],
      providerDescription: String(about.description ?? ''),
      name: capability.name,
      title: capability.title,
      description: capability.description,
      schemaBytes: JSON.stringify(capability.inputSchema ?? {}).length,
      properties: [],
      required: [],
    });
  }
  console.error(`${about.id}: ${declared.capabilities?.length ?? 0}`);
}

await Bun.write(process.argv[2]!, JSON.stringify(out, null, 2));
console.error(`total ${out.length}`);
