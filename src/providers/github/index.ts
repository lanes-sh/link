import { defineProvider } from '#connectivity';
import { GITHUB_REDACT } from './redact.ts';

/**
 * GitHub, through the server GitHub runs.
 *
 * Not OAuth, and not for want of trying. GitHub's remote MCP server does not
 * offer Dynamic Client Registration — the thing that makes Notion and Linear
 * cost fifteen lines — so there is no client to register ourselves as. A client
 * of the operator's own is the documented fallback everywhere else, and it
 * fails here on a detail: an OAuth App matches its callback URL exactly,
 * including the port, and `connect` listens on a port the kernel picks. What is
 * left is the credential GitHub does issue for exactly this — a token you
 * generate once and paste. See ADR-033.
 *
 * The toolsets header is the whole reason `connector.headers` exists. GitHub
 * serves a different tool list per toolset and `all` is far more than an agent
 * reasons over; this asks for the ones an agent working in a repository
 * actually uses. It is one string to change, and `https://lanes.sh/docs/link/github`
 * records the read-only variant for someone who wants a narrower connection.
 */
export const github = defineProvider({
  id: 'github',
  name: 'GitHub',
  description: 'Repositories, issues, pull requests, and workflow runs, via GitHub\'s official MCP server.',
  connector: {
    kind: 'mcp',
    endpoint: 'https://api.githubcopilot.com/mcp/',
    headers: { 'X-MCP-Toolsets': 'context,repos,issues,pull_requests,actions,labels' },
  },
  auth: { kind: 'bearer' },
  // GitHub's own MCP server answers `get_me`, so a tool identity would work.
  // This asks the REST API instead, for one reason: it is a plain GET that
  // costs no MCP handshake, and `connect` runs it before discovery — so when
  // the token is wrong, the thing that fails is the cheap call rather than the
  // expensive one.
  identity: { kind: 'http', url: 'https://api.github.com/user', field: 'login' },
  redact: GITHUB_REDACT,
  setup: {
    summary:
      'GitHub issues a fine-grained personal access token for this. There is no OAuth app to register: ' +
      'GitHub\'s MCP server does not support the dynamic registration Notion and Linear use, and an OAuth ' +
      'app of your own would need a fixed callback port, which this CLI does not have. You are asked once.',
    docs: 'https://lanes.sh/docs/link/github',
    docs_url: 'https://github.com/settings/personal-access-tokens',
    steps: [
      'Open https://github.com/settings/personal-access-tokens and choose "Generate new token".',
      'Name it "Lanes Link" — the name is how you revoke this one later without touching your other tokens — and set an expiry you are willing to renew.',
      'Resource owner: yourself, or the organisation whose repositories you want reachable. An organisation may require an owner to approve the token before it works.',
      'Repository access: only the repositories you want an agent to see. "All repositories" is the setting people regret.',
      'Permissions, matching the toolsets this connects: Contents (read), Metadata (read, added for you), Issues (read and write), Pull requests (read and write), Actions (read). Add Administration or Workflows only if you know you need them.',
      'Generate, then copy the token. GitHub shows it once, and it starts with github_pat_.',
      'When it expires, generate another and run: lanes link connect github --replace.',
    ],
    troubleshooting:
      'GitHub refused the token. The usual causes are an expired token, a repository the token was not granted, ' +
      'or an organisation token still waiting on an owner\'s approval. Generate a new one at ' +
      'https://github.com/settings/personal-access-tokens and re-run: lanes link connect github --replace.',
    prompts: [
      {
        key: 'token',
        label: 'GitHub personal access token',
        secret: true,
        scope: 'connection' as const,
      },
    ],
  },
});
