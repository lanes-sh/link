/**
 * Running an instance and looking at it — everything that is neither
 * `connect` nor the owner layer.
 *
 * Seven files, one per verb group, because every private helper here served
 * exactly one command and nothing crossed between them:
 *
 *   inspect.ts   check, plan, doctor — the gate order, cheapest failure first
 *   status.ts    connections, reachable capabilities, endpoint
 *   outputs.ts   what an agent harness needs, and proving the short form works
 *   dashboard.ts opening the page a local endpoint serves, with the key it needs
 *   serve.ts     start
 *   audit.ts     audit tail and verify, and the Markdown rendering of tail
 *   token.ts     token show, token rotate
 *   policy.ts    policy list/allow/deny, config show
 *
 * This file stays a barrel because `./operate.ts` is the spelling `main.ts` and
 * `operate.test.ts` bind, and Bun will not resolve that to `operate/index.ts`.
 */

export { check, doctor, plan } from './operate/inspect.ts';
export { status } from './operate/status.ts';
export { outputs, type OutputsFlags } from './operate/outputs.ts';
export { tools, type ToolsFlags } from './operate/tools.ts';
export { start } from './operate/serve.ts';
export { dashboard, type DashboardFlags } from './operate/dashboard.ts';
export { auditTail, auditVerify, markdownCell } from './operate/audit.ts';
export { attachFile } from './operate/attach.ts';
export { tokenRotate, tokenShow } from './operate/token.ts';
export { configShow, policyList, policyRule } from './operate/policy.ts';
