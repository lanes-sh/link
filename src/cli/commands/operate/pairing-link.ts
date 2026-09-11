/**
 * What the browser is handed, and what it is told that means.
 *
 * Its own file because it is its own subject, and for the reason the file-size
 * budget exists to point at: `pair.ts` is the command as decisions — a
 * certificate installed, a token minted, an address resolved from a platform —
 * and none of it is about URL shapes or about the paragraph underneath one. The
 * two halves stayed inside the budget until they did not.
 *
 * Nothing here reads configuration or reaches a store. Given a token and an
 * address it returns a string, which is what makes the prose testable at all —
 * and the prose is the part that went wrong: the deployed branch and the
 * loopback branch printed their own copies and drifted, so one of them went on
 * describing a credential that had been withdrawn.
 */

const DASHBOARD_URL = process.env['LANES_WEB_URL'] ?? 'https://lanes.sh';

/**
 * What opening a pairing link actually gets somebody.
 *
 * One paragraph for both modes, because it is one answer: the link carries an
 * address, whoever opens it signs in with Lanes, and what they reach is the
 * profiles listing them. The two branches printed it separately and drifted —
 * the loopback one was corrected for ADR-079 and the deployed one went on
 * promising that the token "reads every connection, profile and audit entry in
 * this workspace", which had stopped being true and was the sentence an
 * operator read while the dashboard refused them.
 *
 * Exported for `pair.test.ts`, which is the only thing that would notice it
 * drifting again.
 */
export function pairingGuidance(): string {
  return (
    '      Open that in a browser. The link carries the address, so the page knows\n' +
    '      which endpoint to ask; it is not a key to it.\n' +
    '      Whoever opens it signs in with Lanes, and reaches the profiles that list\n' +
    '      them as a member — their connections, their audit entries, and the memory,\n' +
    '      tasks, files, skills and entities inside them, to read, edit and delete.\n' +
    '      A profile listing nobody is reachable by nobody. It changes no connection,\n' +
    '      token, policy rule or configuration, and never reads a vault value.\n' +
    '      To end their access: lanes link profile members remove <subject>\n' +
    '      — which stops the next sign-in; one already made runs its course.'
  );
}

/**
 * The link the browser opens.
 *
 * The token rides in the fragment, which is never sent to a server — so a
 * credential for a surface whose entire point is that Lanes cannot see this
 * data does not land in a Lanes access log, a proxy, or a referrer header. The
 * address rides beside it for the same reason and one more: it is the only
 * thing telling the page which of several paired endpoints this link is for,
 * and a query parameter would put a workspace's public address in that log.
 *
 * **A loopback link carries its address too**, and the parameter is required so
 * that it cannot quietly stop. It used to be omitted here on the reasoning that
 * loopback is derivable — and it is not: the read listener sits one port above
 * whatever `instance.port` says, so an endpoint on any port but the default
 * printed a link the dashboard then read at `7338`, reported unreachable, and
 * gave no way to correct. The page still treats a link with no `at=` as
 * loopback on the default port, because every link minted before this is that
 * shape.
 *
 * Exported for `pair.test.ts` and for nothing else. The whole of the defect
 * above was a shape nothing asserted on, in a command whose output no test
 * reads, so the fix is not worth much without something that fails when the
 * address goes missing again.
 */
export function pairingLink(token: string, endpoint: string): string {
  return `${DASHBOARD_URL}/dashboard/link#pair=${token}&at=${encodeURIComponent(endpoint)}`;
}
