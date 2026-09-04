/**
 * What the dashboard may do to the owner's own data, as one narrow interface.
 *
 * ADR-069 is the decision this expresses: a pairing token reads and writes
 * memory, tasks, assets, skills and entities, lists the vault by name, and
 * cannot reach a connection, a profile, a grant, a token, the configuration or
 * the log. The shape of that permission is the shape of this file — there is no
 * method here for anything the ADR refuses, which is a stronger guarantee than
 * a check inside one.
 *
 * **It lives under `cli` because only `cli` may reach both a store and the
 * log.** `src/architecture.test.ts` gives `dispatch` no path to `#providers`
 * and `server` no path to either, so the alternative was widening the table for
 * one surface. `server/read/data.ts` imports these *types* and nothing else,
 * which is the same seam `readRoutes` already keeps with `AuditTail`.
 *
 * **Nothing here throws for a refusal.** A missing profile, a store the profile
 * cannot reach and a document that will not parse are all answers rather than
 * failures, and a route that had to tell an exception it expected from one it
 * did not would get it wrong on the day it mattered. `Answer<T>` carries both.
 */

/**
 * The stores a person may browse.
 *
 * A closed tuple, not a string: it is the whole of what ADR-069 opened, and the
 * route validates against it rather than against whatever a caller sends.
 * `identity` and `setup` are absent deliberately — both are configuration, and
 * configuration is the CLI's (ADR-007).
 */
export const DATA_STORES = ['memory', 'tasks', 'assets', 'skills', 'entities', 'vault'] as const;

export type DataStoreName = (typeof DATA_STORES)[number];

export function isDataStore(value: string): value is DataStoreName {
  return (DATA_STORES as readonly string[]).includes(value);
}

/** The stores a write may name. The vault is readable by name and never writable. */
export function isWritableStore(store: DataStoreName): boolean {
  return store !== 'vault';
}

/** One row in a listing. Enough to scan; never enough to be the document. */
export interface DataItem {
  readonly id: string;
  readonly title: string;
  /** The one line under the title: a task's status, an asset's type and size. */
  readonly summary: string | null;
  readonly updatedAt: string | null;
  readonly tags: readonly string[];
}

export interface DataDetail extends DataItem {
  /**
   * The document exactly as it is stored, frontmatter included.
   *
   * Raw rather than a parsed object, because the panel that edits this would
   * otherwise need a field per frontmatter key and a second copy of every
   * store's schema. `null` where there is no text form: a binary asset, a vault
   * item.
   */
  readonly body: string | null;
  /** Why this cannot be edited here, or `null` when it can. Shown verbatim. */
  readonly readOnly: string | null;
  /** Assets only. Lets a reader choose between rendering, showing and describing. */
  readonly contentType: string | null;
  readonly bytes: number | null;
}

/** An asset's bytes, for the one route that serves them. */
export interface DataContent {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * A refusal, with the status the surface should answer.
 *
 * `404` for anything whose existence is not this caller's to learn, `409` for a
 * profile that grants no connection to the store asked for, and `400` for a
 * document the store will not accept. Only the last carries a message worth
 * showing: the other two are the same answer an unknown path gets, on purpose.
 */
export interface DataRefusal {
  readonly status: 400 | 404 | 409;
  readonly error: string;
  readonly message: string;
}

export type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: DataRefusal };

export function answered<T>(value: T): Answer<T> {
  return { ok: true, value };
}

export function refused<T>(
  status: DataRefusal['status'],
  error: string,
  message: string,
): Answer<T> {
  return { ok: false, refusal: { status, error, message } };
}

/** Every read and write names the profile whose data it means. Never defaulted. */
export interface DataScope {
  readonly profile: string;
  readonly store: DataStoreName;
}

export interface ListOptions extends DataScope {
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * Who is asking, for the log.
 *
 * A pairing token authenticates the workspace's owner at a browser rather than
 * an agent, and the log should be able to say so: a row written from here and a
 * row written by a connected client are the same kind of event and must not
 * look like the same actor.
 */
export const DASHBOARD_PRINCIPAL = 'lanes:dashboard';

export interface DataSurface {
  list(options: ListOptions): Promise<Answer<DataItem[]>>;
  read(options: DataScope & { id: string }): Promise<Answer<DataDetail>>;
  /** An asset's bytes. Refused for every other store. */
  content(options: { profile: string; name: string }): Promise<Answer<DataContent>>;
  create(options: DataScope & { body: string }): Promise<Answer<DataDetail>>;
  write(options: DataScope & { id: string; body: string }): Promise<Answer<DataDetail>>;
  remove(options: DataScope & { id: string }): Promise<Answer<void>>;
}
