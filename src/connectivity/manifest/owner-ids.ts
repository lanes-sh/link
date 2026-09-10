/**
 * The owner layer's provider ids, and the map from what they used to be called.
 *
 * Their own file because `provider.ts` is a schema and the cross-field rules a
 * schema cannot express, and these are neither — they are a fixed list of ids
 * that happens to have been declared beside the thing that once reserved them.
 * The budget in `architecture.test.ts` names exactly this as what earns a split:
 * "something that is not a schema appearing beside them". It came out when a
 * third per-capability record needed room next to `redact` and `hints`, and the
 * file was at 400 lines to the line.
 *
 * Nothing about the values changed in the move, and every consumer reads them
 * through `#connectivity` rather than this path.
 */


/**
 * The owner layer's provider ids — Lanes' own surfaces.
 *
 * **`lanes_` on each, which is what stops them needing to be reserved.** They
 * were `memory`, `tasks`, `assets`, `skills`, `vault`, `entities` — six of the
 * most obvious words a vendor manifest might want, held back from every
 * operator so the built-ins could have them. `buildRegistry` registers these
 * before `PROVIDERS`, so a manifest claiming one threw at startup rather than
 * being shadowed (ADR-051); the reservation is what made that a refusal instead
 * of a collision. Prefixed, there is nothing to reserve: an operator's own
 * `memory` connector is now a legal thing to declare.
 *
 * It is also the shape the vendor-qualified providers already use —
 * `google_tasks`, `gmail_imap`, `icloud_mail` — and it reads the same way: the
 * half before the underscore says whose surface this is.
 *
 * The order is read: `#server/mcp`'s instructions emit one paragraph per
 * reachable id in this sequence, so it is the order an agent meets them in.
 * `lanes_entities` is appended rather than inserted alphabetically so that it
 * lands beside `lanes_identity`: the two answer the same question about
 * different people, and the instructions collapse them into one paragraph when
 * both are reachable.
 */
export const RESERVED_PROVIDER_IDS: readonly string[] = [
  'lanes_memory',
  'lanes_tasks',
  'lanes_assets',
  'lanes_skills',
  'lanes_vault',
  'lanes_setup',
  'lanes_identity',
  'lanes_entities',
];

/**
 * Old id to new, for a refusal that can name what a stale client is asking for.
 *
 * Nothing consumes it yet. The migration builds its own map from
 * `C3_OWNER_PROVIDERS` (`src/cli/contract4-rename.ts`), and a `tools/call` on a
 * pre-0.9.0 name is answered by the SDK's exact-match lookup before anything
 * here sees it — so the refusal this exists for is still unwritten. ADR-066
 * records the failure it would address.
 */
export const RENAMED_OWNER_PROVIDERS: ReadonlyMap<string, string> = new Map(
  RESERVED_PROVIDER_IDS.map((id) => [id.slice('lanes_'.length), id]),
);
