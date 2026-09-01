import type { ProviderManifest } from '#connectivity';

/**
 * Turn a refused registration into something an operator can act on.
 *
 * A provider declaring `registration: 'dynamic'` is promising that its
 * authorization server will register a client on demand — that is the whole
 * reason those providers need no setup. When the server refuses, the SDK throws
 * the status and nothing else, and "Dynamic Client Registration rejected (HTTP
 * 403): Forbidden" tells the reader neither what was being attempted nor that
 * there is nothing wrong with their machine.
 *
 * It is a real state rather than a bug: a server may advertise a registration
 * endpoint and gate it behind a plan, an allowlist, or a signed-in session.
 * Figma's does, which is how this was found. What the operator needs to know is
 * that the refusal came from the provider, that we sent nothing wrong, and
 * where the answer lives — which is the provider's own documentation, because
 * whatever unlocks it is theirs to state.
 */
export async function registering<T>(
  manifest: ProviderManifest,
  serverUrl: string,
  run: () => Promise<T>,
): Promise<T> {
  if (manifest.auth.kind !== 'oauth' || manifest.auth.registration !== 'dynamic') return run();

  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/registration/i.test(message)) throw error;

    const host = new URL(serverUrl).host;
    throw new Error(
      `${manifest.name} refused to register this machine as a client.\n` +
        `  ${message}\n` +
        '\n' +
        `  Nothing was written, and nothing about your setup is wrong: ${host}\n` +
        '  advertises registration and then declined it. That is usually a plan, an\n' +
        '  allowlist, or an account that has to be signed in first.\n' +
        `  What unlocks it is theirs to say: ${docsFor(manifest) ?? host}`,
    );
  }
}

/** Where the provider tells you what it wants, when the manifest names it. */
function docsFor(manifest: ProviderManifest): string | undefined {
  const setup = (manifest as { setup?: { docs_url?: unknown } }).setup;
  return typeof setup?.docs_url === 'string' ? setup.docs_url : undefined;
}
