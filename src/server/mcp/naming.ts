/**
 * Capability ids on the wire.
 *
 * MCP tool names are restricted to `[A-Za-z0-9_-]`, so the dotted capability id
 * becomes `gmail_search` on the wire. The dotted form stays canonical
 * everywhere it matters — config, policy rules, audit records — because that is
 * what an operator reads and writes. Only the wire name is transliterated, and
 * the mapping is total and reversible because provider ids and capability names
 * both exclude `-`.
 */

export const SERVER_NAME = 'lanes-link';

export function toolNameFor(capabilityId: string): string {
  return capabilityId.replace(/\./g, '_');
}

/**
 * Recover the capability id a wire name came from.
 *
 * Splitting on the first `_` was reversible while a capability name was one
 * segment. It stopped being so when OpenAPI operationIds arrived dotted:
 * `gmail_users_drafts_send` splits to `gmail.users_drafts_send`, which names
 * nothing. That only shows up in the audit record for a refused tool — a log
 * entry saying an agent tried something that does not exist, spelled wrongly,
 * is worse than useless.
 *
 * So the known ids are consulted first, and the split is the fallback for a
 * name matching no capability at all — where an approximate spelling is the
 * best available and the attempt is what matters.
 */
export function capabilityIdForToolName(toolName: string, known?: Iterable<string>): string {
  for (const id of known ?? []) {
    if (toolNameFor(id) === toolName) return id;
  }

  const index = toolName.indexOf('_');
  return index === -1 ? toolName : `${toolName.slice(0, index)}.${toolName.slice(index + 1)}`;
}
