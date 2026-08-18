import { z } from 'zod';

/**
 * Connectivity types — how we reach a service.
 *
 * One schema per transport in `../transports/`, and the discriminated union
 * below is the complete list. A provider picks exactly one; how it
 * *authenticates* is the other axis entirely (`./auth.ts`), which is what lets
 * iCloud speak IMAP with a password while Gmail speaks HTTP with OAuth and
 * neither costs the other any code.
 */

/**
 * Proxy an upstream MCP server. Capabilities are **discovered**, never declared
 * — the server is the source of truth for what it exposes.
 */
export const mcpConnectorSchema = z.object({
  kind: z.literal('mcp'),
  endpoint: z.url(),
});

/**
 * A REST API described by OpenAPI. Operations become capabilities mechanically,
 * so a service without an MCP server still costs no translation code.
 */
export const httpConnectorSchema = z.object({
  kind: z.literal('http'),
  base_url: z.url(),
  /** URL or workspace-relative path to an OpenAPI 3.x document. */
  openapi: z.string().min(1),
  /**
   * Glob filters on operationId, path, or tag.
   *
   * Not optional in spirit: a large spec yields hundreds of operations, which
   * is a tool list no agent can reason over. For an `http` connector,
   * "everything discovered" means everything selected here.
   */
  operations: z
    .object({
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .optional(),
});

/**
 * A mailbox over IMAP4rev1, and optionally SMTP submission.
 *
 * Vendor-neutral: iCloud, Fastmail, and a company Dovecot are the same handful
 * of fields. Unlike `http` there is no document to read — IMAP describes its
 * *extensions* through CAPABILITY but never its operations — so the capability
 * set belongs to the connector rather than to the manifest.
 */
export const imapConnectorSchema = z.object({
  kind: z.literal('imap'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  smtp: z
    .object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).default(587),
      /** 587 upgrades in-band; 465 is implicit TLS. Either way TLS is required. */
      starttls: z.boolean().default(true),
      /**
       * Largest message this host will accept, encoded, in bytes.
       *
       * A server limit the provider declares, like `max_range_days` above.
       * Attachments are base64 in the wire format, so the usable weight of the
       * files themselves is about three quarters of this — the send path derives
       * that rather than making a caller do the arithmetic.
       *
       * The default is iCloud's 20 MB, which is also roughly where the common
       * hosts sit. Worth checking one is refused *before* dialling: a message
       * rejected part-way through `DATA` reads as a network failure, and a caller
       * that cannot tell the difference tries again.
       */
      max_message_bytes: z
        .number()
        .int()
        .positive()
        .max(157_286_400)
        .default(20 * 1024 * 1024),
    })
    .optional(),
  /**
   * How much of a body one call may return.
   *
   * A 40 MB newsletter is not something an agent's context survives, and where
   * to draw that line has to be our decision rather than whatever the message
   * happens to weigh.
   */
  max_body_bytes: z.number().int().positive().max(4_194_304).default(262_144),
});

/**
 * CalDAV and CardDAV — HTTPS, but XML under PROPFIND and REPORT, which no
 * OpenAPI document describes, so `http` cannot serve it. Auth is ordinary Basic,
 * which is the payoff for keeping auth orthogonal to connectivity.
 */
export const davConnectorSchema = z.object({
  kind: z.literal('dav'),
  /** Where discovery begins; RFC 6764 well-known paths are tried under it. */
  base_url: z.url(),
  service: z.enum(['caldav', 'carddav']),
  /**
   * Longest `list_events` window this server will answer.
   *
   * A server limit, so the provider declares it rather than the transport
   * assuming it. iCloud rejects a wider range than a year; every server slows
   * down over one, which is why there is a default rather than no bound.
   */
  max_range_days: z.number().int().positive().max(3650).default(366),
});

/**
 * A directory on the machine this runs on.
 *
 * Vendor-neutral: iCloud Drive is a manifest pointing at its folder, and the
 * same connector serves Dropbox, Syncthing, or a project directory. There is no
 * credential — access to a Mac's iCloud Drive is a TCC grant bound to a binary
 * on that Mac, not a token, so there is nothing to store and nothing that could
 * be carried to another machine. See ADR-011.
 */
export const fsConnectorSchema = z.object({
  kind: z.literal('fs'),
  /** May start with `~`. Everything reachable is under it, symlinks included. */
  root: z.string().min(1),
  max_file_bytes: z.number().int().positive().max(4_194_304).default(262_144),
  /** Extra names never listed or read, on top of the built-in refusals. */
  exclude: z.array(z.string()).default([]),
  /**
   * How this folder's sync client marks a file it has not downloaded.
   *
   * macOS represents a dataless iCloud Drive file as a hidden sibling named
   * `.<name>.icloud`, so a listing shows a name that cannot be read and a read
   * returns a few hundred bytes of plist — which looks like a corrupt file
   * rather than an absent one. A folder synced by something else uses a
   * different convention, or none.
   *
   * Declared rather than assumed: this is the one place the word "icloud" would
   * otherwise be hard-coded into a transport that also serves Dropbox,
   * Syncthing, and a plain project directory. `hint` is the remedy, in the
   * provider's own words, because "run brctl" is advice only Apple's answer can
   * give.
   */
  placeholder: z
    .object({
      suffix: z.string().min(1),
      hint: z.string().optional(),
    })
    .optional(),
});

/** Our own code — `example`, and the owner layer. */
export const localConnectorSchema = z.object({
  kind: z.literal('local'),
});

export const connectorSchema = z.discriminatedUnion('kind', [
  mcpConnectorSchema,
  httpConnectorSchema,
  imapConnectorSchema,
  davConnectorSchema,
  fsConnectorSchema,
  localConnectorSchema,
]);

export type ConnectorConfig = z.infer<typeof connectorSchema>;
