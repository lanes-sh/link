import { z } from 'zod';
import { authSchema } from './auth.ts';
import { bundleSchema } from './bundles.ts';
import { connectorSchema } from './connector.ts';
import { identitySchema } from './identity.ts';
import { identifier } from './primitives.ts';
import { setupSchema } from './setup.ts';

/**
 * A provider manifest.
 *
 * A provider is a *declaration*, not a package: a connectivity type plus auth
 * configuration. `providers/gmail` was 612 lines of hand-written endpoint
 * translation; the same integration is now roughly fifteen lines of data.
 *
 * The same schema serves two callers, deliberately:
 *
 *   - built-ins, written as typed TS modules under `#providers/` and validated
 *     at import
 *   - workspace manifests in `~/.lanes-link/providers/*.yaml`, validated on load
 *
 * That second one is the scalability claim. A service nobody has integrated is
 * a YAML file the operator writes, not a pull request they wait on.
 */
export const providerManifestSchema = z.object({
  id: identifier,
  name: z.string().min(1),
  version: z.string().default('1.0.0'),
  description: z.string().default(''),

  connector: connectorSchema,
  auth: authSchema.default({ kind: 'none' }),
  setup: setupSchema.optional(),
  bundles: z.array(bundleSchema).optional(),
  /** How to label a connection with the account it actually belongs to. */
  identity: identitySchema.optional(),

  /**
   * Per-capability audit redaction: capability name → argument keys worth
   * recording. Everything unlisted is reduced to a type marker.
   *
   * The default is to withhold every value, which is the only safe default when
   * we did not author the capability and cannot know what is sensitive.
   */
  redact: z.record(z.string(), z.array(z.string())).optional(),

  /**
   * Per-capability prose appended to a generated description: capability name →
   * what the vendor's own wording leaves out.
   *
   * Keyed exactly like `redact`, and for a related reason. A generated tool
   * describes its *arguments* faithfully and its *meaning* not at all, because
   * the vendor wrote the document for someone who already knows the product.
   * Where a capability is the answer to a question nothing about it mentions —
   * an operation whose enum of magic strings is the whole feature, or a job that
   * lives on a different provider entirely — that fact has to be sayable
   * somewhere, and the only somewhere a model reads is the description.
   *
   * Appended rather than replacing, so a vendor improving their own wording is
   * not silently discarded.
   */
  hints: z.record(z.string(), z.string()).optional(),
});

export type ProviderManifest = z.infer<typeof providerManifestSchema>;

/** Provider ids reserved for the owner layer. */
export const RESERVED_PROVIDER_IDS: readonly string[] = ['memory', 'skills', 'vault', 'setup'];

/**
 * Validate a manifest, with the cross-field rules the schema alone cannot
 * express.
 *
 * These stay here rather than in the section files precisely because they span
 * sections: a `dav` connector constrains the *auth* kind, an `oauth` block with
 * manual registration constrains *setup*. A rule about one section alone
 * belongs in that section's schema; everything left over is here, which is a
 * short list and should stay one.
 *
 * Built-ins call this at import so a malformed provider fails there rather than
 * at first use; the YAML loader calls it too.
 */
export function defineProvider(input: unknown): ProviderManifest {
  const parsed = providerManifestSchema.safeParse(input);
  if (!parsed.success) {
    const where = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid provider manifest:\n${where}`);
  }

  const manifest = parsed.data;

  if (manifest.auth.kind === 'oauth' && manifest.auth.registration === 'manual') {
    if (!manifest.auth.app) {
      throw new Error(
        `Provider "${manifest.id}": OAuth with registration "manual" needs an "app" naming the oauth_apps entry that holds the client.`,
      );
    }
    if (!manifest.setup || manifest.setup.prompts.length === 0) {
      throw new Error(
        `Provider "${manifest.id}": OAuth with registration "manual" requires the operator to supply a client, so it must declare setup prompts. Otherwise there is no way to learn what to provide.`,
      );
    }
  }

  if (
    (manifest.auth.kind === 'bearer' ||
      manifest.auth.kind === 'api_key' ||
      manifest.auth.kind === 'header' ||
      manifest.auth.kind === 'basic') &&
    manifest.auth.app &&
    manifest.auth.credential_ref
  ) {
    throw new Error(
      `Provider "${manifest.id}": auth declares both "app" and "credential_ref", which contradict. ` +
        `"app" means one secret per account shared across a vendor's providers; "credential_ref" means one secret shared across every account. Pick the one that is true.`,
    );
  }

  for (const prompt of manifest.setup?.prompts ?? []) {
    if (prompt.scope === 'shared' && !prompt.credential_ref) {
      throw new Error(
        `Provider "${manifest.id}": setup prompt "${prompt.key}" is shared across accounts, so it must name the credential_ref it writes to.`,
      );
    }
    if (prompt.scope === 'connection' && prompt.credential_ref) {
      throw new Error(
        `Provider "${manifest.id}": setup prompt "${prompt.key}" is per-account, so its credential_ref derives and must not be declared — it would name a connection that does not exist yet.`,
      );
    }
  }

  if (manifest.auth.kind === 'basic') {
    const perAccount = (manifest.setup?.prompts ?? []).filter((p) => p.scope === 'connection');
    if (perAccount.length > 0) {
      const has = (field: string): number => perAccount.filter((p) => p.field === field).length;
      if (has('username') !== 1 || has('password') !== 1) {
        throw new Error(
          `Provider "${manifest.id}": basic auth stores "username:password", so it needs exactly one prompt with field "username" and one with field "password".`,
        );
      }
    }
  }

  if (
    (manifest.connector.kind === 'imap' || manifest.connector.kind === 'dav') &&
    manifest.auth.kind !== 'basic'
  ) {
    // Every mail and DAV host that matters issues an app password and expects
    // it over Basic. OAuth for these exists — Apple shipped one in Oct 2025 —
    // but is partner-gated with no published scopes, so declaring it would be a
    // manifest that validates and then cannot authenticate. Fail here instead.
    throw new Error(
      `Provider "${manifest.id}": a ${manifest.connector.kind} connector authenticates with a username and password, so it must declare auth "basic".`,
    );
  }

  if (manifest.connector.kind === 'fs' && manifest.auth.kind !== 'none') {
    // Nothing to authenticate to. The permission is the operating system's, held
    // against the process, and there is no credential to store or to leak.
    throw new Error(
      `Provider "${manifest.id}": an fs connector reads a local folder and holds no account, so it must declare auth "none".`,
    );
  }

  if (manifest.connector.kind === 'local' && manifest.auth.kind !== 'none') {
    throw new Error(
      `Provider "${manifest.id}": a local connector runs our own code and holds no third-party account, so it must declare auth "none".`,
    );
  }

  const names = new Set<string>();
  for (const bundle of manifest.bundles ?? []) {
    if (names.has(bundle.name)) {
      throw new Error(`Provider "${manifest.id}" declares bundle "${bundle.name}" twice`);
    }
    names.add(bundle.name);
  }

  return manifest;
}
