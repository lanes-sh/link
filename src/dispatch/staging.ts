import { createHash } from 'node:crypto';
import type { AuditSink } from '#audit';
import type { Principal } from '#auth';
import {
  getStaged,
  newHandle,
  putStaged,
  sweepStaged,
  STAGED_TTL_MS,
  type StagedFile,
} from '#connectivity/mail';
import type { BlobStore } from '#stores/blobs';
import { scopeBlobStore } from '#stores/blobs';
import { scopeNamespace } from './context.ts';

/**
 * Taking bytes now for a call to name later.
 *
 * In dispatch rather than in the transport that receives the upload, for two
 * reasons. The dependency direction is one: `server` may not reach a store, and
 * should not — how blobs are namespaced is not something a component that speaks
 * HTTP has any business knowing. The audit log is the other, and the better one.
 * Staging is a write against one account: it puts the operator's file *inside*
 * the endpoint, where a later send can post it outward. That belongs in the same
 * log as the send, and this is the only place that writes it.
 *
 * Beside `dispatch.ts` rather than in it because it shares nothing with `invoke`
 * but the deps — no policy evaluation, no rate limit, no connector — and that
 * file was at the size budget, which is the budget doing its job.
 */

export interface StageRequest {
  readonly principal: Principal;
  readonly providerId: string;
  readonly connectionId: string;
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
  readonly clientLabel?: string | undefined;
}

export interface StagedAttachment {
  readonly handle: string;
  readonly sha256: string;
  readonly expiresAt: number;
}

export async function stageAttachment(
  deps: {
    readonly storage: BlobStore;
    readonly audit: AuditSink;
    readonly profile: string;
    readonly now: () => number;
  },
  request: StageRequest,
): Promise<StagedAttachment> {
  // Namespaced per provider and connection, exactly as `buildProviderContext`
  // scopes the store it hands a provider — which is what makes the handle
  // resolvable from that connection and from no other.
  const storage = scopeBlobStore(
    deps.storage,
    scopeNamespace(request.providerId, request.connectionId),
  );

  // Swept before writing: staging is the only thing that creates this garbage,
  // and there is no scheduler in this process, so the moment someone stages is
  // both the cheapest and the most reliable time to clear the last batch. A
  // failure to sweep must not fail the upload — the worst case is a stale blob
  // that the next sweep catches.
  await sweepStaged(storage).catch(() => 0);

  const handle = newHandle();
  const sha256 = createHash('sha256').update(request.bytes).digest('hex');
  const expiresAt = deps.now() + STAGED_TTL_MS;

  await putStaged(storage, {
    handle,
    bytes: request.bytes,
    metadata: {
      filename: request.filename,
      content_type: request.contentType,
      sha256,
      expires_at: expiresAt,
    },
  });

  await deps.audit.append({
    profile: deps.profile,
    principal: request.principal.id,
    ...(request.clientLabel ? { clientLabel: request.clientLabel } : {}),
    provider: request.providerId,
    connection: `${request.providerId}.${request.connectionId}`,
    capability: 'attachments.stage',
    // Identifiers, not content — the same rule the send path follows. The
    // filename and digest are what make "which file entered the endpoint" an
    // answerable question; the bytes are the thing being withheld.
    arguments: {
      filename: request.filename,
      bytes: request.bytes.byteLength,
      content_type: request.contentType,
      sha256,
    },
    authorization: 'allowed',
    status: 'ok',
    durationMs: 0,
  });

  return { handle, sha256, expiresAt };
}

export interface FetchStagedRequest {
  readonly principal: Principal;
  readonly providerId: string;
  readonly connectionId: string;
  readonly handle: string;
  readonly clientLabel?: string | undefined;
}

/**
 * Handing bytes back out, which is the half staging was missing.
 *
 * Upload always worked: bytes in over HTTP, a handle through the model, a send
 * that names it. The other direction had no route at all — an attachment that
 * arrived by mail could be *described* by `get_message` and attached to an
 * outgoing message by `send_message`, and there was no way to simply have it.
 * The only paths out were to mail it somewhere else or to base64 it through the
 * conversation, which is the cost this whole design exists to avoid.
 *
 * So it is the same shape run backwards, and deliberately the same scoping: the
 * store is namespaced by provider and connection here exactly as it is above, so
 * a handle minted for `icloud_mail.main` is fetchable from that connection and
 * from no other. Nothing is bridged and no provider gains reach it did not have
 * — the bytes were already inside this account's namespace, and this is a door
 * onto it rather than a route between two.
 *
 * Null for "no such handle", "expired", and "wrong connection" alike. A caller
 * cannot act on the difference, and distinguishing them would let someone probe
 * for handles staged against an account they cannot reach.
 */
export async function fetchStaged(
  deps: {
    readonly storage: BlobStore;
    readonly audit: AuditSink;
    readonly profile: string;
  },
  request: FetchStagedRequest,
): Promise<StagedFile | null> {
  const storage = scopeBlobStore(
    deps.storage,
    scopeNamespace(request.providerId, request.connectionId),
  );

  const found = await getStaged(storage, request.handle);

  // Logged either way. "Did anything leave the endpoint" is the question this
  // answers, and a miss is as worth having as a hit — a run of them against
  // handles that do not exist is what probing looks like.
  await deps.audit.append({
    profile: deps.profile,
    principal: request.principal.id,
    ...(request.clientLabel ? { clientLabel: request.clientLabel } : {}),
    provider: request.providerId,
    connection: `${request.providerId}.${request.connectionId}`,
    capability: 'attachments.fetch',
    arguments: {
      handle: request.handle,
      ...(found
        ? { filename: found.filename, bytes: found.bytes.byteLength, content_type: found.contentType }
        : {}),
    },
    authorization: 'allowed',
    status: found ? 'ok' : 'error',
    durationMs: 0,
  });

  return found;
}
