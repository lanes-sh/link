/**
 * Audit — append-only, generic across providers.
 *
 * Every capability invocation produces exactly one event, whether it was
 * allowed, denied, rate-limited, or failed. Denials are the interesting half:
 * an audit log that only records successes cannot answer "what did this agent
 * try to do".
 *
 * Audit records support investigation. They do not prevent an action, and this
 * module makes no claim that they do.
 */

import type { AuditVerification } from './chain.ts';

export type {
  AuditVerification,
  ChainBreak,
  ChainedEvent,
  ChainFields,
  RunMarker,
  StoredRecord,
} from './chain.ts';
export {
  auditKey,
  dayPrefix,
  decodeEvent,
  encodeEvent,
  hashBytes,
  newRunId,
  runMarkerKey,
  stampOf,
  verifyChain,
} from './chain.ts';

/** Why a request ended the way it did. */
export type AuthorizationResult =
  | 'allowed'
  | 'denied_by_policy'
  | 'denied_default' // nothing granted it — the default-deny path
  | 'denied_unauthenticated'
  | 'denied_rate_limited'
  | 'denied_connection_unauthorized'; // credential missing or expired

export type InvocationStatus = 'ok' | 'error' | 'not_invoked';

export interface AuditEvent {
  readonly id: string;
  readonly timestamp: Date;

  /** Which profile's endpoint served this. */
  readonly profile: string;

  /**
   * The authenticated principal. In M1 there is exactly one per profile (the
   * owner), but the field is recorded rather than assumed so that adding
   * delegated access later does not change the log's shape.
   */
  readonly principal: string;

  /**
   * The MCP `clientInfo` name, when the caller repeated it on the request.
   *
   * OBSERVABILITY ONLY. This is self-reported by the client and is never
   * consulted for authorization — it exists so you can see which agent made a
   * call, not to decide what that agent may do.
   *
   * "On the request" is load-bearing and was wrong for this field's whole life:
   * it claimed to hold the `clientInfo` name and read an `x-mcp-client` header
   * that no MCP client sends, so it was empty on every event ever written. The
   * name arrives in the request envelope now (`mcp/client-info.ts`). A client
   * that announces itself only at `initialize` and never repeats it is still
   * anonymous here, which is the honest answer rather than one inferred.
   */
  readonly clientLabel?: string;

  readonly provider: string;
  readonly connection?: string;
  readonly capability: string;

  /**
   * Redacted argument metadata. Never raw arguments: a Gmail search query can
   * contain the very content the caller was not allowed to read, and a vault
   * lookup key can name a secret. Providers declare what survives redaction.
   */
  readonly arguments: Readonly<Record<string, unknown>>;

  readonly authorization: AuthorizationResult;
  readonly status: InvocationStatus;
  readonly durationMs: number;
  readonly error?: { readonly kind: string; readonly message: string };
}

/** What is known before dispatch; the rest is filled in by the writer. */
export type AuditDraft = Omit<AuditEvent, 'id' | 'timestamp'>;

/**
 * Where events go.
 *
 * There is no `update` and no `delete`, and that absence IS the
 * `audit.append-only` guarantee — it is enforced by the type system rather
 * than by convention or by a database trigger. Do not add one. Retention, if
 * it is ever needed, belongs in a separate operator-run command that is
 * explicitly outside this interface.
 *
 * Writing is separate from reading because not every sink can be read back. A
 * log shipped to stdout or to an OTLP collector is somebody else's to query,
 * and giving those a `tail` that throws would be a worse interface than not
 * offering one.
 */
export interface AuditSink {
  append(draft: AuditDraft): Promise<AuditEvent>;
  /**
   * Finish this writer's run.
   *
   * Not merely releasing a handle: it is what lets `verify` tell a run that
   * ended from a run whose tail was cut off. See `./chain.ts`.
   */
  close(): Promise<void>;
}

/** A sink whose events can be read back — a local directory, or a bucket. */
export interface AuditReader {
  tail(options?: AuditQuery): Promise<AuditEvent[]>;
  /**
   * Check every chain in the log.
   *
   * Deliberately takes no range. A chain is only checkable while it is
   * contiguous, so verifying "since Tuesday" would drop the records each
   * remaining link is defined against and report breaks that are artefacts of
   * the filter. All of it, or none of it. If that ever becomes slow, retention
   * is the answer, and it lives outside this interface.
   */
  verify(): Promise<AuditVerification>;
}

export interface AuditStore extends AuditSink, AuditReader {}

export interface AuditQuery {
  readonly limit?: number;
  readonly since?: Date;
  readonly provider?: string;
  readonly connection?: string;
  readonly capability?: string;
  /** Restrict to denials — the common investigative question. */
  readonly deniedOnly?: boolean;
}

/**
 * What a provider is handed. A provider can add detail to its own invocation's
 * record; it cannot read the log, and it cannot write an event attributed to
 * anything other than the call in progress.
 */
export interface AuditLogger {
  /** Attach provider-specific, already-redacted detail to this invocation. */
  annotate(detail: Readonly<Record<string, unknown>>): void;
}

/**
 * A provider's redaction rules: given raw capability arguments, return what is
 * safe to persist.
 *
 * The default, applied when a provider declares nothing, is to record argument
 * *names* and value types but no values. Providers opt into recording specific
 * values (a message id is useful and harmless; a search query is neither).
 */
export type RedactionRule = (args: Readonly<Record<string, unknown>>) => Record<string, unknown>;

export const redactAllValues: RedactionRule = (args) => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = `<${describeType(value)}>`;
  }
  return out;
};

/** Keep the listed keys verbatim; reduce everything else to a type marker. */
export function keepKeys(...keys: readonly string[]): RedactionRule {
  const keep = new Set(keys);
  return (args) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      out[key] = keep.has(key) ? value : `<${describeType(value)}>`;
    }
    return out;
  };
}

/**
 * Keep some keys verbatim, withhold others entirely, type-mark the rest.
 *
 * `keepKeys` covers the common case and cannot express the vault's: reducing a
 * secret to `<string:40>` still discloses its length, while the id beside it is
 * a name worth recording verbatim — an audit log that cannot say *which* item
 * was written answers very little. Withheld keys record `<withheld>` and
 * nothing else.
 *
 *     redaction({ keep: ['id'], withhold: ['value'] })
 *
 * A key in both is withheld: the stricter rule wins, so a mistake here fails
 * closed.
 */
export function redaction(options: {
  readonly keep?: readonly string[];
  readonly withhold?: readonly string[];
}): RedactionRule {
  const keep = new Set(options.keep ?? []);
  const withhold = new Set(options.withhold ?? []);

  return (args) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (withhold.has(key)) out[key] = '<withheld>';
      else if (keep.has(key)) out[key] = value;
      else out[key] = `<${describeType(value)}>`;
    }
    return out;
  };
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array:${value.length}`;
  if (typeof value === 'string') return `string:${value.length}`;
  return typeof value;
}
