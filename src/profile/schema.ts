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
 *
 * **2 moved `targets:` out of the profile and into the workspace** (ADR-052). A
 * profile used to declare the adapter sets it could be opened against, which
 * meant a deploy left two copies of every profile — one in the workspace and one
 * in the bucket the endpoint reads — with nothing keeping them honest. Now a
 * workspace *is* a target: it declares its own adapters once, holds the profiles
 * that live in it, and a profile is one copy in one place.
 *
 * A hard cut, and contract 1 is not read here. `./legacy.ts` understands it, and
 * only the migration uses that — a runtime that loaded either shape would be the
 * two-sources-of-truth problem again, one level up.
 */
export const SUPPORTED_CONTRACT = 2;

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
  // Non-empty here rather than in a referential check further down. Under
  // contract 1 `assertReferentialIntegrity` walked the profile's `targets:`
  // block for these; the block is the workspace's now (ADR-052), and a
  // constraint the schema can express belongs in the schema — an empty service
  // name should fail at load, not minutes into a build.
  region: z.string().min(1),
  service: z.string().min(1),
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
 * One adapter set — where credentials are kept, where bytes go, where it rolls.
 *
 * Declared by the **workspace** that is this target, not by a profile in it
 * (ADR-052). The `cloudrun:` spelling `deploy:` replaced is gone with contract
 * 1; `./legacy.ts` still normalises it, on the one path that reads a contract-1
 * file at all.
 */
export const targetSchema = z.object({
  credentials: credentialsTargetSchema,
  audit: auditTargetSchema.optional(),
  storage: storageTargetSchema,
  vault: vaultTargetSchema.optional(),
  deploy: deployTargetSchema.optional(),
});

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
 *
 * `label` is the operator's own word for the same row, and it exists because
 * `account` cannot be. Three things read `account` as an identity — the
 * reconnect match in `settleIdentity`, the id derived from it, and the `From`
 * header `gmail.send_message` writes — so a `relabel` that wrote "Work mail"
 * there stopped the next `connect` recognising the account it had renamed.
 * Nothing addresses a connection by its label; it is only ever displayed.
 */
export const connectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/, 'must be lowercase alphanumeric with underscores'),
  provider: identifier,
  account: z.string().min(1),
  /** Absent means the row is shown as its account, which is the usual case. */
  label: z.string().min(1).optional(),
  credential_ref: credentialRef.optional(),
  /** Provider-specific, validated later against that provider's own schema. */
  config: z.record(z.string(), z.unknown()).optional(),
});

export const oauthAppSchema = z.object({
  client_id_ref: credentialRef,
  client_secret_ref: credentialRef,
});


/**
 * One profile: who it is, what it reaches, and what it may do.
 *
 * **It does not say where it runs.** A profile lives in exactly one workspace
 * and that workspace is a target (ADR-052), so the adapter set is a property of
 * where the file is, not of what is in it. `instance.default_target` went with
 * `targets:` — it was already inert under ADR-037, and contract 2 is the release
 * that stops carrying it.
 */
export const configSchema = z.object({
  contract: z.number().int().positive(),

  instance: z.object({
    profile: identifier,
    port: z.number().int().min(1).max(65535).default(7337),
    /**
     * Loopback by default. Binding elsewhere is possible but the server
     * refuses to combine it with anonymous auth.
     */
    host: z.string().default('127.0.0.1'),
  }),

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
       * default is a wildcard is `src/server/cors.ts` and ADR-039.
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
   * Memory and skills, somewhere other than the target's own storage (ADR-041).
   *
   * On the profile rather than the target, which is where contract 1 kept it.
   * That was never really a property of the adapter set — it says where *this
   * profile's* notes live — and it had to be per-target only because a profile
   * could be declared against several. It lives in exactly one now (ADR-052), so
   * per-profile and per-profile-per-target are the same thing, and this is the
   * one of the two that matches what ADR-030 says a profile owns.
   *
   * Optional and absent by default, so a profile that says nothing keeps both
   * where it keeps everything else. See `knowledge.ts` for why these two are
   * separable from the rest and why the credential store and the vault are not.
   */
  knowledge: knowledgeTargetSchema.optional(),

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

/**
 * One entry in the workspace's target registry.
 *
 * Two shapes, and which one a workspace writes says who owns the target:
 *
 * - **A declaration** — `credentials` and `storage`, and whatever else the
 *   adapter set needs. This workspace *is* that target. `~/.lanes-link` writes
 *   one of these for `local`.
 * - **A pointer** — `workspace: gs://bucket[/prefix]`, and nothing else. The
 *   target lives elsewhere and the workspace at that URI declares it. This is
 *   what a machine holds for `cloud`.
 *
 * The pointer is why there is nothing to sync. ADR-044 added an index beside the
 * profile's own `targets:` block and had to insist it was "an index, not
 * configuration", because resolving from it would have made it a second source
 * of truth. Here it is the *only* source: the profile declares no target at all,
 * so a pointer and a declaration cannot disagree — there is one of them per
 * target, in one file (ADR-052).
 *
 * A declaration for a target that is not deployed yet is the bootstrap case and
 * is allowed: `deploy` reads it, creates the remote workspace, writes the
 * declaration *there*, and replaces this one with a pointer. That is the only
 * moment a target is described in two places, and it does not outlive the
 * command.
 */
export const workspaceTargetSchema = z
  .object({
    /** A pointer: where the workspace declaring this target lives. */
    workspace: z.string().min(1).optional(),
    credentials: credentialsTargetSchema.optional(),
    audit: auditTargetSchema.optional(),
    storage: storageTargetSchema.optional(),
    vault: vaultTargetSchema.optional(),
    deploy: deployTargetSchema.optional(),
    /**
     * Whose bearer token opens this endpoint (ADR-009).
     *
     * Recorded rather than inferred. One endpoint serves every profile in the
     * workspace under one token, and which profile's token that is decides who
     * gets in — the one question about a deployment that must not be guessed at.
     */
    primary: identifier.optional(),
    last_deploy: z.string().optional(),
    /**
     * The CLI release that rolled the revision serving this target.
     *
     * Written by `deploy`, after the rollout rather than before it, so a build
     * that failed does not leave a version recorded that never served anything.
     * The image is built from the installed package, so the CLI that ran the
     * deploy is the code running up there — which makes this the only way to ask
     * "what version is the endpoint" without an endpoint answering.
     *
     * In the target's own workspace as well as on the machine that deployed it:
     * a second laptop reading the registry learns it too, and `target show`
     * prints it beside `last_deploy`.
     */
    last_deploy_version: z.string().optional(),
  })
  .superRefine((entry, ctx) => {
    const declares = entry.credentials !== undefined || entry.storage !== undefined;

    // Both is the state ADR-052 exists to prevent, and it is worth refusing
    // rather than preferring one: a pointer beside a declaration is two answers
    // to "where are this target's bytes", and picking either silently is how the
    // fifteen-connection bucket got reported as seven.
    if (declares && entry.workspace !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'names a "workspace" and also declares adapters — a target is declared by exactly ' +
          'one workspace. Keep the adapters here, or keep the pointer and declare them there.',
      });
      return;
    }

    if (!declares && entry.workspace === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'declares neither "workspace" nor "credentials" and "storage" — a target either ' +
          'lives here or points at where it does.',
      });
      return;
    }

    if (declares && (entry.credentials === undefined || entry.storage === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [entry.credentials === undefined ? 'credentials' : 'storage'],
        message: 'a target declared here needs both "credentials" and "storage"',
      });
    }
  });

/**
 * The workspace file: `lanes-link.yaml`, alongside a `profiles/` directory.
 *
 * `default_profile` is parsed and ignored, as it has been since ADR-037 — it
 * survives so `check` can say it is inert rather than the schema stripping it
 * silently. `deployments:` is gone; `targets` above is what it became.
 */
export const workspaceSchema = z.object({
  contract: z.number().int().positive(),
  default_profile: identifier.optional(),
  targets: z.record(z.string(), workspaceTargetSchema).default({}),
});

export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
export type WorkspaceTarget = z.infer<typeof workspaceTargetSchema>;

/** Whether a registry entry points elsewhere rather than declaring the target. */
export function isPointer(
  entry: WorkspaceTarget,
): entry is WorkspaceTarget & { workspace: string } {
  return entry.workspace !== undefined;
}

/**
 * The adapter set a registry entry declares, or undefined for a pointer.
 *
 * A pointer has to be followed before there is anything to open, which is
 * `resolveTargetWorkspace`'s job — this only narrows the shape once it has been.
 */
export function declaredTarget(entry: WorkspaceTarget): TargetConfig | undefined {
  if (entry.credentials === undefined || entry.storage === undefined) return undefined;
  return {
    credentials: entry.credentials,
    storage: entry.storage,
    ...(entry.audit ? { audit: entry.audit } : {}),
    ...(entry.vault ? { vault: entry.vault } : {}),
    ...(entry.deploy ? { deploy: entry.deploy } : {}),
  };
}
