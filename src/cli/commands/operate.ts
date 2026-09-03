/**
 * Running an instance and looking at it — everything that is neither
 * `connect` nor the owner layer.
 *
 * Eight files, one per verb group, because every private helper here served
 * exactly one command and nothing crossed between them:
 *
 *   inspect.ts   check, plan, doctor — the gate order, cheapest failure first
 *   auth.ts      whether each connection can still authenticate, by asking
 *   status.ts    connections, reachable capabilities, endpoint
 *   outputs.ts   what an agent harness needs, and proving the short form works
 *   desktop.ts   opening the Lanes app, on the page that drives this CLI
 *   serve.ts     start
 *   pair.ts      pair — the dashboard's read surface (ADR-063)
 *   audit.ts     audit tail and verify, and the Markdown rendering of tail
 *   token.ts     token show, token rotate
 *   policy.ts    policy list/allow/deny, config show
 *
 * This file stays a barrel because `./operate.ts` is the spelling `main.ts` and
 * `operate.test.ts` bind, and Bun will not resolve that to `operate/index.ts`.
 */

export { check, doctor, plan } from './operate/inspect.ts';
export { auth, classifyOAuth, type AuthFlags, type AuthVerdict, type ConnectionAuth } from './operate/auth.ts';
export { status } from './operate/status.ts';
export { outputs, type OutputsFlags } from './operate/outputs.ts';
export { tools, type ToolsFlags } from './operate/tools.ts';
export { start } from './operate/serve.ts';
export { pair, PAIR_CERT_REF, PAIR_KEY_REF, PAIR_TOKEN_REF, type PairFlags } from './operate/pair.ts';
export { desktop, settingsUrl, type DesktopFlags } from './operate/desktop.ts';
export { auditTail, auditVerify, markdownCell } from './operate/audit.ts';
export { attachFile } from './operate/attach.ts';
export {
  tokenIssue,
  tokenList,
  tokenRevoke,
  tokenRotate,
  tokenShow,
} from './operate/token.ts';
export { configShow, policyList, policyRule } from './operate/policy.ts';
