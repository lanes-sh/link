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
 *   - the profile's own manifests in `data/<profile>/providers.d/*.yaml`, validated on load
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
export const RESERVED_PROVIDER_IDS: readonly string[] = ['memory', 'skills', 'vault', 'setup', 'identity'];

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

  // Declared in the union and not implemented, which is a worse state than
  // either. `refuseStrategy` throws, but it throws at *dispatch* — so a manifest
  // declaring one validates here, connects, stores a credential, discovers its
  // capabilities and is granted a policy rule, and then fails on every single
  // call. That is the failure shape the mcp rule below calls unacceptable,
  // reached by another door. Nothing is registered, so nothing legitimate is
  // refused; when the first strategy exists, this rule narrows to unknown names.
  if (manifest.auth.kind === 'strategy') {
    throw new Error(
      `Provider "${manifest.id}": auth strategy "${manifest.auth.strategy}" is not registered. ` +
        'Strategies are the only place per-vendor code belongs, and there is none for this one — ' +
        'the connection would authorise and then fail on every call. ' +
        'See docs/detailed/creating-a-provider.md.',
    );
  }

  if (manifest.auth.kind === 'oauth' && manifest.auth.registration === 'manual') {
    if (!manifest.auth.app) {
      throw new Error(
        `Provider "${manifest.id}": OAuth with registration "manual" needs an "app" naming the oauth_apps entry that holds the client.`,
      );
    }
    // Prompts are required only when asking is the *only* way to get a client.
    // A broker is the other way, so a provider that declares one and no prompts
    // simply has no bring-your-own path — a legal thing to be. The CLI is where
    // that absence becomes visible, by refusing the flag and saying why.
    if (!manifest.auth.broker && (!manifest.setup || manifest.setup.prompts.length === 0)) {
      throw new Error(
        `Provider "${manifest.id}": OAuth with registration "manual" requires the operator to supply a client, so it must declare setup prompts. Otherwise there is no way to learn what to provide.`,
      );
    }
  }

  if (manifest.auth.kind === 'oauth' && manifest.auth.broker) {
    if (manifest.auth.registration !== 'manual' || !manifest.auth.app) {
      throw new Error(
        `Provider "${manifest.id}": a broker supplies a pre-registered client, so auth must declare registration "manual" and an "app" naming the oauth_apps entry that overrides it.`,
      );
    }
    if (!manifest.auth.authorize_url) {
      throw new Error(
        `Provider "${manifest.id}": a broker performs the exchange, but the browser still goes to the vendor, so auth.authorize_url is required.`,
      );
    }
    // An MCP provider hands the whole flow to the SDK, which posts to the token
    // endpoint with whatever `clientInformation()` returned and has nowhere to
    // route an exchange somebody else performs. Declaring both endpoints is
    // what opts it off that path and onto the direct one, where the exchange is
    // ours — so on an mcp connector the two arrive together or the manifest is
    // describing a flow that cannot run. Refused here rather than discovered
    // after the operator has already approved a consent screen. See ADR-040.
    if (manifest.connector.kind === 'mcp' && !manifest.auth.token_url) {
      throw new Error(
        `Provider "${manifest.id}": an mcp connector runs the exchange through the SDK, which cannot route it through a broker, unless the manifest declares its own endpoints. Add auth.token_url beside auth.authorize_url, or drop the broker and register dynamically.`,
      );
    }
  }

  if (manifest.auth.kind === 'oauth' && manifest.auth.assertion) {
    // Same seam, same absence as the broker rule above. The SDK owns an mcp
    // provider's exchange and takes a client, not a signed assertion — so the
    // choice would be offered, accepted, and then have nowhere to go.
    if (manifest.connector.kind === 'mcp') {
      throw new Error(
        `Provider "${manifest.id}": an mcp connector runs the exchange through the SDK, which cannot present a signed assertion. Remove auth.assertion.`,
      );
    }
    // The assertion carries `aud` from the key file, but the *scopes* it claims
    // come from the manifest. A provider requesting none would mint a token
    // permitted to do nothing and only find out at the first call.
    if (manifest.auth.scopes.length === 0) {
      throw new Error(
        `Provider "${manifest.id}": auth.assertion exchanges a signed assertion for a token scoped to auth.scopes, which is empty. There would be nothing to grant.`,
      );
    }
    // The whole point of the alternative is that it asks for something. A block
    // with no prompt reaches the walkthrough and then has nothing to collect.
    if (manifest.auth.assertion.setup.prompts.length === 0) {
      throw new Error(
        `Provider "${manifest.id}": auth.assertion declares no setup prompts, so there is no way to learn what key to ask for.`,
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

  // Two answers to "where does the browser come back to", and a manifest
  // naming both leaves it to whichever the flow reads first. A broker's
  // redirect is its own HTTPS origin, with the loopback port carried in
  // `state`; a fixed redirect is this machine, named exactly. Neither is wrong,
  // but they cannot both be in force.
  if (manifest.auth.kind === 'oauth' && manifest.auth.broker && manifest.auth.redirect_uri) {
    throw new Error(
      `Provider "${manifest.id}": auth may declare "broker" or "redirect_uri", not both — a brokered flow redirects to the broker and carries the loopback port in state, so a fixed redirect would never be used.`,
    );
  }

  // Connector headers are for what the *server* offers as configuration; the
  // credential is the auth block's, and a manifest setting both would have one
  // quietly overwrite the other depending on which the transport merged last.
  //
  // Checked for every connector that has the field rather than for `mcp` alone.
  // It was written when `mcp` was the only one, and the reasoning never had
  // anything to do with which transport carried the header — an `http`
  // connector naming `Authorization` collides with `auth` in exactly the same
  // way, and would have validated cleanly.
  const connectorHeaders =
    'headers' in manifest.connector ? (manifest.connector.headers ?? {}) : {};
  for (const name of Object.keys(connectorHeaders)) {
    if (name.toLowerCase() === 'authorization') {
      throw new Error(
        `Provider "${manifest.id}": connector.headers may not set "${name}" — the credential comes from auth, and setting both would leave which one is sent up to merge order.`,
      );
    }
  }

  if (manifest.connector.kind === 'mcp') {
    const auth = manifest.auth;

    // The transport sends exactly one header, `Authorization: Bearer <token>`,
    // because that is what the MCP specification says a client sends. Every
    // other token kind puts the secret somewhere the transport has nowhere to
    // put it: `api_key` in a query string or a named header, `header` under a
    // name of its own, `basic` in a different scheme entirely. Such a manifest
    // validates and then connects *unauthenticated* — no error, an empty tool
    // list, and nothing to read that says why.
    if (auth.kind !== 'none' && auth.kind !== 'oauth' && auth.kind !== 'bearer') {
      throw new Error(
        `Provider "${manifest.id}": an mcp connector authenticates with "Authorization: Bearer", so its auth must be "none", "oauth", or "bearer" — not "${auth.kind}". There is nowhere else on the request for the transport to put a credential.`,
      );
    }

    // Same failure, one field further in. `bearer` may rename its header, and
    // `resolveBearer` honours that — but the mcp transport does not read the
    // resolved credential at all, only the token, so a renamed header would be
    // silently ignored and the token sent under `Authorization` regardless.
    if (auth.kind === 'bearer' && auth.header) {
      throw new Error(
        `Provider "${manifest.id}": an mcp connector always sends its token as "Authorization: Bearer", so auth.header ("${auth.header}") cannot be honoured. Remove it, or reach this service with an http connector.`,
      );
    }
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
