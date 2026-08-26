import { z } from 'zod';
import { browserOrigin, capabilityPattern, credentialRef, identifier } from './primitives.ts';
import { authorizationSchema } from './authorization.ts';
import { identitySchema } from './identity.ts';
import { knowledgeTargetSchema } from './knowledge.ts';

/**
 * Configuration is declarative desired state. This file is the source of truth
 * for what exists; the credential store holds values, and the database holds
 * only runtime state.
 *
 * That split exists because the deployed target scales to zero: administering a
 * remote instance by shelling into a container or connecting to its database is
 * not workable. Declared config plus a reconcile step on boot removes that
 * problem and makes the whole setup diffable and reproducible.
 *
 * The CLI's mutating commands edit this file rather than the database.
 * Declarative config and an imperative CLI are not opposites — `lanes link connect` is
 * a convenience that produces a correct file, so nobody has to hand-edit YAML,
 * while the file remains the single source of truth.
 */

/**
 * The config contract major version.
 *
 * A config declaring a major this binary does not implement is rejected
 * outright — never a best-effort load. Guessing at an unknown schema on a file
 * that governs authorization is how you end up granting something the operator
 * did not write.
 */
export const SUPPORTED_CONTRACT = 1;

/**
 * There is no `database:` block any more.
 *
 * State — connections, provider state, cursors — is one object per key in the
 * blob store `storage:` already names, and the log is objects beside it
 * (ADR-020). There was nothing left for a second declaration to choose. A
 * profile written before this keeps its `database:` key and it is ignored:
 * zod strips unknown keys, so an old file loads unchanged rather than failing
 * on a field that no longer means anything.
 */

export const credentialsTargetSchema = z.object({
  adapter: z.enum(['file', 'gcp-secret-manager']),
  path: z.string().optional(),
  project: z.string().optional(),
});

export const storageTargetSchema = z.object({
  adapter: z.enum(['filesystem', 'gcs', 's3']),
  path: z.string().optional(),
  bucket: z.string().optional(),
  /**
   * The S3-compatible service endpoint. Named for the protocol rather than a
   * vendor (ADR-013) — Supabase Storage, R2, MinIO, and AWS differ only in this
   * URL. `gcs` needs none of this: it addresses Google's own API and
   * authenticates as the identity already present.
   */
  endpoint: z.string().optional(),
  region: z.string().optional(),
  /** Bucket-relative key prefix; the S3 equivalent of `path`. */
  prefix: z.string().optional(),
  /**
   * Two refs rather than one, because `SecretStore` holds strings and a key
   * pair is two of them. Packing both into one value would mean encoding a
   * secret that routinely contains `/` and `+`, and an encoding bug in a
   * credential path fails at the least convenient moment.
   *
   * The access key id is a ref too, though it is closer to a username than a
   * secret: Supabase issues 32-character hex ids, which the config secret
   * detector reads as a high-entropy blob and rejects inline.
   */
  access_key_id_ref: credentialRef.optional(),
  secret_access_key_ref: credentialRef.optional(),
});

/**
 * Extra places the log is copied to.
 *
 * Never a replacement: the durable log is objects in the blob store, written
 * and awaited, and these are copies written best-effort behind a bounded
 * queue. A collector being down must not fail a capability call, so a sink
 * that can fail cannot be the one the guarantee rests on.
 */
export const auditSinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stdout') }),
  z.object({
    kind: z.literal('otlp'),
    /** The logs endpoint, e.g. `https://collector.example/v1/logs`. */
    endpoint: z.string().url(),
    /** Static headers, as a credential ref: an API key belongs in the store. */
    headers_ref: credentialRef.optional(),
    service_name: z.string().optional(),
  }),
]);

export const auditTargetSchema = z.object({
  /** Copies, in addition to the durable log. Empty or absent means no copies. */
  sinks: z.array(auditSinkSchema).default([]),
});

/**
 * Where the vault's encrypted document lives.
 *
 * Its own block rather than a reuse of `credentials`, because the vault must
 * never be the credential store — the two hold different things and collapsing
 * them is the single most damaging mistake available here (`docs/detailed/security.md`).
 *
 * Optional, defaulting to `file`: every profile written before ADR-014 keeps
 * working unchanged, and a local run needs no vault configuration at all.
 *
 * `secret` is what a deployment uses: the whole sealed document as one entry in
 * the target's own credential store. Not a merge of the two stores — it is
 * ciphertext by the time it arrives, under a different key from a different
 * environment variable, and the bucket arrangement it replaces was protecting
 * the smaller asset with the taller fence (ADR-022).
 *
 * One entry rather than one per item, because the document is encrypted whole:
 * item *names* are inside it, and a secret-per-item mapping would publish
 * those names into a cloud IAM console to gain nothing this does not have.
 *
 * `blob` remains, for a target that would rather keep it beside the other
 * objects.
 */
export const vaultTargetSchema = z.object({
  adapter: z.enum(['file', 'blob', 'secret']),
  /** File path, or blob key. Defaults to `./data/<profile>.vault.enc` / `vault.enc`. */
  path: z.string().optional(),
  /** `secret` only: where the sealed document lives. Defaults to `vault/document`. */
  ref: credentialRef.optional(),
});

/**
 * Where a target is rolled out, and who may reach it once it is.
 *
 * `platform` is the discriminator, and it is the only thing that decides which
 * driver runs — the block used to be named `cloudrun`, which meant the *name of
 * a key* selected a vendor and a second host could only ever be a second
 * optional block that the loader had to disambiguate. Adapters are named for the
 * protocol and deployments for the vendor (ADR-013); `platform` is how a target
 * says which vendor without the schema growing a key per vendor.
 *
 * `project` is optional here for the same reason `credentials.project` is: it
 * means something to one platform and nothing to the next, so the driver that
 * needs it is the thing that refuses without it. The alternative — a
 * discriminated union per platform — buys precision this file cannot use and
 * costs a schema edit on every field any host ever adds.
 */
export const deployTargetSchema = z.object({
  platform: z.enum(['cloudrun']),
  region: z.string(),
  service: z.string(),
  /**
   * `iam` puts the platform's own identity check in front of the service;
   * `public` leaves the door open and relies on this application's gate.
   *
   * Defaults to `iam`, so a target that says nothing gets the closed one. Note
   * what `iam` costs: it admits only callers who can mint an identity token for
   * the host's own IAM, which no agent harness can do. A target reached by
   * Claude or ChatGPT wants `public` plus an `auth.authorization` block, and
   * that combination is the one `deploy` proposes.
   */
  access: z.enum(['iam', 'public']).default('iam'),
  /** Required by the `cloudrun` driver; meaningless to a platform without projects. */
  project: z.string().optional(),
  /**
   * The billing account to attach `project` to, when this deploy created it.
   *
   * Present only when the project did not exist at survey time, and it is what
   * makes the difference between a deploy that provisions a project and one that
   * deploys into a project you already had. Absent is the ordinary case, and
   * means "assume the project is there and billed".
   *
   * Not a credential: a billing account id names an account, it does not
   * authorise a charge against it — spending is authorised by the IAM role your
   * own login holds on it. So it belongs in config rather than the secret store,
   * and `secret-detection.ts` has no reason to refuse it.
   */
  billing_account: z.string().optional(),
  /** The identity the running revision assumes. Needs read access to the credential store. */
  service_account: z.string().optional(),
  /**
   * Instances kept running when nothing is calling.
   *
   * Zero is the default and the right answer for almost everything here: a cold
   * start on the MCP path measures under three seconds, and the platform queues
   * the request behind it, so scaling to zero is invisible to a caller.
   *
   * It is a knob because one path is not a caller. A client refreshes its token
   * exactly when it wakes after an idle gap — which is exactly when the instance
   * is cold — and a refresh that fails at the network level sends a remote
   * client through a fresh browser authorization rather than surfacing an error.
   * Raise it if a re-authorization ever lines up with a cold `/token`.
   */
  min_instances: z.number().int().min(0).max(10).default(0),
});

/**
 * The pre-`deploy` spelling, still accepted.
 *
 * Normalised into `deploy` below rather than read anywhere, so exactly one shape
 * reaches the rest of the codebase. It gains `access: iam` in the process, which
 * is a deliberate change of default for a config that predates the field — a
 * deploy that was open stays open only by saying so.
 */
const legacyCloudRunSchema = z.object({
  project: z.string(),
  region: z.string(),
  service: z.string(),
});

export const targetSchema = z
  .object({
    credentials: credentialsTargetSchema,
    audit: auditTargetSchema.optional(),
    storage: storageTargetSchema,
    vault: vaultTargetSchema.optional(),
    /**
     * Memory and skills, somewhere other than `storage` above.
     *
     * Optional and absent by default, so every profile written before it keeps
     * storing both exactly where it did. See `knowledge.ts` for why these two
     * are separable from the rest and why the credential store and the vault
     * are not.
     */
    knowledge: knowledgeTargetSchema.optional(),
    deploy: deployTargetSchema.optional(),
    /** @deprecated Write `deploy` with `platform: cloudrun`. */
    cloudrun: legacyCloudRunSchema.optional(),
  })
  .superRefine((target, ctx) => {
    // Both present is refused rather than resolved by precedence: a second place
    // to say where this deploys could only ever disagree with the first, and
    // silently preferring one would roll a revision to the project the operator
    // was not reading.
    if (target.deploy && target.cloudrun) {
      ctx.addIssue({
        code: 'custom',
        path: ['cloudrun'],
        message:
          'both "deploy" and "cloudrun" are declared — remove "cloudrun", which "deploy" replaces',
      });
    }
  })
  .transform(({ cloudrun, ...target }) =>
    target.deploy || !cloudrun
      ? target
      : {
          ...target,
          // The pre-`deploy` spelling predates both of these, so it gets the
          // same defaults the current one would: the closed door, and no
          // instance kept warm.
          deploy: {
            ...cloudrun,
            platform: 'cloudrun' as const,
            access: 'iam' as const,
            min_instances: 0,
          },
        },
  );

/**
 * A rule is a pattern, and usually just a string.
 *
 * The object form exists only for `expires_at`; writing `gmail.*` should not
 * require learning a record shape. Both parse to the same thing.
 */
export const policyRuleSchema = z.union([
  capabilityPattern.transform((capability) => ({ capability })),
  z.object({
    capability: capabilityPattern,
    expires_at: z.iso.datetime({ offset: true }).optional(),
  }),
]);

/**
 * One policy block for the whole profile.
 *
 * Rules name capabilities, never connections. Every account of a provider in a
 * profile is governed identically, and granularity comes from running a
 * narrower profile — profiles already share no database, no credential store,
 * and no URL, which is a stronger boundary than a policy row ever was. The
 * agent still names which account it is calling; policy simply does not
 * discriminate between them.
 *
 * Default deny still holds where it counts: an absent or empty `policy` grants
 * nothing at all. `connect` writes `allow: ['*']` because a connection you just
 * authorised and cannot use is a bad first impression — but that is a default
 * written into your file, visible and editable, not a behaviour of the engine.
 */
export const policySchema = z.object({
  allow: z.array(policyRuleSchema).default([]),
  deny: z.array(policyRuleSchema).default([]),
});

/**
 * One authorised account.
 *
 * `account` is the identity as the provider knows it — an email address, a
 * workspace name — resolved at connect time rather than invented. A file that
 * says `Gmail main2` cannot answer the only question anyone asks of it, which
 * is *whose mailbox is this*. `id` is the stable key that `credential_ref` and
 * the agent's `connection` argument point at, and it is derived from `account`
 * so it means something too.
 */
export const connectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/, 'must be lowercase alphanumeric with underscores'),
  provider: identifier,
  account: z.string().min(1),
  credential_ref: credentialRef.optional(),
  /** Provider-specific, validated later against that provider's own schema. */
  config: z.record(z.string(), z.unknown()).optional(),
});

export const oauthAppSchema = z.object({
  client_id_ref: credentialRef,
  client_secret_ref: credentialRef,
});


export const configSchema = z.object({
  contract: z.number().int().positive(),

  instance: z.object({
    profile: identifier,
    /**
     * @deprecated Parsed, never read. See ADR-037.
     *
     * Every command names its target on the command line now, so nothing
     * consults this. It stays *declared* rather than being dropped, and that is
     * the whole point: an undeclared key is stripped silently by the schema,
     * which would leave `check` and `doctor` with nothing to report and an
     * operator staring at a line they reasonably believe still selects
     * something. Declaring it is what lets them be told it is inert.
     *
     * Optional, so a profile written today needs no such line, and unvalidated,
     * so a stale value naming a target that no longer exists is harmless rather
     * than a failure on a key nothing reads. The `database:` note above records
     * the same decision for the same reason.
     */
    default_target: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).default(7337),
    /**
     * Loopback by default. Binding elsewhere is possible but the server
     * refuses to combine it with anonymous auth.
     */
    host: z.string().default('127.0.0.1'),
  }),

  targets: z.record(z.string(), targetSchema),

  auth: z
    .object({
      mode: z.literal('bearer').default('bearer'),
      token_ref: credentialRef.default('profile/token'),
      /**
       * Additive. `mode` above still describes what the endpoint accepts on the
       * wire — a bearer token — and this describes where a *remote* client can
       * get one. Omitting it leaves every existing profile behaving identically.
       */
      authorization: authorizationSchema.optional(),
      /**
       * Browser origins that may call a *deployment's* MCP endpoint. Absent
       * means `*`, so naming any is a narrowing and nothing needs setting.
       *
       * A deployment only, and this cannot widen that: a loopback endpoint
       * refuses every cross-origin request and must keep doing so. Why the
       * default is a wildcard is `src/server/cors.ts` and ADR-040.
       */
      allowed_origins: z.array(browserOrigin).optional(),
    })
    .default({ mode: 'bearer', token_ref: 'profile/token' }),

  limits: z
    .object({
      requests_per_minute: z.number().int().positive().default(120),
      upstream_calls_per_minute: z.number().int().positive().default(60),
    })
    .default({ requests_per_minute: 120, upstream_calls_per_minute: 60 }),

  oauth_apps: z.record(identifier, oauthAppSchema).default({}),

  /**
   * There is no `providers` block. A provider is enabled by having a connection
   * to it — a second place to say so could only ever disagree with the first,
   * and everything else a provider needs is in its manifest.
   */
  connections: z.array(connectionSchema).default([]),
  policy: policySchema.default({ allow: [], deny: [] }),

  /**
   * Who the owner is, for anything written as them. Optional and additive, so
   * every profile written before it keeps loading unchanged — the same reasoning
   * as `auth.authorization` above, and the reason `contract` does not move.
   */
  identity: identitySchema.default([]),
});

export type Config = z.infer<typeof configSchema>;
export type ConnectionConfig = z.infer<typeof connectionSchema>;
export type PolicyRuleConfig = z.infer<typeof policyRuleSchema>;
export type TargetConfig = z.infer<typeof targetSchema>;
export type DeployConfig = z.infer<typeof deployTargetSchema>;
export type AuthorizationConfig = z.infer<typeof authorizationSchema>;
export { authorizationSchema, identitySchema };
export type { IdentityEntry } from './identity.ts';

/** The workspace file: `lanes-link.yaml`, alongside a `profiles/` directory. */
export const workspaceSchema = z.object({
  contract: z.number().int().positive(),
  default_profile: identifier.optional(),
});

export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
