import { defineProvider } from '#connectivity';
import { GMAIL_IDENTITY, GOOGLE_APP } from '../shared/oauth.ts';
import { googleSetup } from '../shared/setup.ts';

/**
 * Gmail via Google's MCP server. Workspace Developer Preview members only.
 *
 * Deliberately not `GMAIL_SCOPES`. The server *advertises* five, including
 * `mail.google.com` — read, send, and permanently delete. Requesting the full
 * advertised set was tried, on the theory that the servers reject a subset, and
 * it made no difference: with all five granted, `tools/list` succeeds and every
 * `tools/call` still answers "The caller does not have permission". The gate is
 * enrolment in Google's Workspace Developer Preview, not scope.
 *
 * That is the opposite of the REST provider's situation, where scope is exactly
 * the gate — hence two lists. Widening this one buys nothing that has been
 * demonstrated, so it stays at what Google documents. If calls still fail once
 * preview access is granted, widening is the next thing to try — `connect` warns
 * about the gap either way.
 */
const GMAIL_MCP_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

export const gmailMcp = defineProvider({
  id: 'gmail_mcp',
  name: 'Gmail (Google MCP)',
  description:
    'Read and compose mail via Google\'s official Gmail MCP server. Requires Workspace Developer Preview enrolment — use "gmail" otherwise.',
  connector: { kind: 'mcp', endpoint: 'https://gmailmcp.googleapis.com/mcp/v1' },
  auth: { kind: 'oauth', registration: 'manual', app: GOOGLE_APP, scopes: GMAIL_MCP_SCOPES },
  identity: GMAIL_IDENTITY,
  setup: googleSetup('Gmail', GMAIL_MCP_SCOPES, { preview: true }),
});
