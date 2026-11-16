import { readConnections } from './workspace.ts';
import type { EndpointToken } from './schema.ts';

/**
 * The endpoint's static tokens, which belong to the workspace (ADR-068).
 *
 * **Why this is not a field on a profile any more.** `auth.token_ref` defaulted
 * to the constant `profile/token` for every profile, out of a credential store
 * that has been one per workspace since ADR-057 — so naming a profile to find
 * the endpoint's token asked a question with one answer, and every command whose
 * subject is the endpoint had to ask it. `profile/removal.ts` records the
 * sharper consequence: removing one profile deleted the token its siblings were
 * being served by, and the deployed revision then refused every request.
 *
 * **A row names a person.** That is the part that changes behaviour rather than
 * merely moving a file. A bearer token used to resolve to `ownerPrincipal` of
 * whichever profile was primary, with `profiles: undefined` — "all of them" —
 * so it was the one credential on this endpoint that answered *what may I open*
 * without ever answering *who are you*. A row carries a Lanes subject, so the
 * token resolves through the profile's `members:` exactly as an OAuth token has
 * since ADR-060, and `mayReach` needs no special case for it.
 *
 * The value is never in the file. A row holds a `ref` into the workspace's
 * credential store, which is what keeps `findSecrets` with nothing to find.
 */

/** Where a row's value lives in the workspace credential store. */
export function tokenRef(id: string): string {
  return `tokens/${id}`;
}

/**
 * The next free row id, `tok1` upward.
 *
 * Same shape as `nextConnectionId` and opaque for the same reason: the id ends
 * up in a listing and in a credential path, and an id derived from the label or
 * the subject would either collide or leak. `label` is the field for saying what
 * a token is for.
 */
export function nextTokenId(taken: readonly string[]): string {
  let highest = 0;
  for (const id of taken) {
    const match = /^tok([0-9]+)$/.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `tok${highest + 1}`;
}

/**
 * Every token this workspace has issued.
 *
 * Read through `readConnections` rather than the filesystem, so a deployed
 * revision whose root is a bucket URL loads them (ADR-049). A workspace that has
 * issued none returns empty, which is not an error: it is what a fresh install
 * looks like, and what a workspace looks like after `token revoke` removes the
 * last row.
 */
export async function readEndpointTokens(
  workspaceRoot: string,
): Promise<readonly EndpointToken[]> {
  return (await readConnections(workspaceRoot)).tokens;
}

export type { EndpointToken };

/**
 * Any token this workspace holds, for talking to its own endpoint.
 *
 * `outputs`, `tools`, `doctor` and the reload notification all need *a* valid
 * credential to ask the endpoint something, and none of them cares whose: they
 * are the operator's own commands run against the operator's own workspace.
 * Which row answers is therefore not a choice worth making visible — unlike
 * `token show`, where it is the whole subject of the command and `--id` is
 * required once there is more than one.
 *
 * **Null is an ordinary answer, not a failure.** A workspace that has issued
 * none is the common case after ADR-062: a person's client registers against
 * the bare URL and signs in, so nothing needs a static token until something
 * headless does. Every caller degrades — reporting what it could not ask rather
 * than minting a credential nobody asked for, which is what the old
 * `ensureProfileToken` did on six different commands.
 */
export async function anyIssuedToken(
  workspaceRoot: string,
  credentials: { get(ref: string): Promise<string | null> },
): Promise<{ readonly id: string; readonly value: string } | null> {
  for (const row of await readEndpointTokens(workspaceRoot)) {
    const value = await credentials.get(row.ref);
    if (value) return { id: row.id, value };
  }
  return null;
}
