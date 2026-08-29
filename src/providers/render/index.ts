import { defineProvider } from '#connectivity';

/**
 * Render, with an API key you paste.
 *
 * Render's server offers OAuth but not dynamic client registration, and its
 * authorization server accepts only public clients — so the browser route needs
 * a client registered somewhere this program cannot reach. Render also accepts
 * an ordinary API key, which is the route that works without one, and is the
 * same trade `../github` makes for the same reason.
 */
export const render = defineProvider({
  id: 'render',
  name: 'Render',
  description: 'Services, deploys, logs, and environment variables, via Render\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.render.com/mcp' },
  auth: { kind: 'bearer' },
  setup: {
    summary:
      'Render takes an API key rather than a browser sign-in here. It is created in your account ' +
      'settings, it does not expire, and it reaches every workspace your account can.',
    docs_url: 'https://render.com/docs/api',
    steps: [
      'Sign in at https://dashboard.render.com and open Account Settings → API Keys.',
      'Create a key and name it "Lanes Link" — the name is how you revoke this one later without cutting off anything else.',
      'Copy it. Render shows it once.',
    ],
    troubleshooting:
      'A rejected key is usually one that was rotated, or one copied from a different account. Create a new one at ' +
      'https://dashboard.render.com under Account Settings → API Keys and re-run: lanes link connect render --replace.',
    prompts: [
      { key: 'token', label: 'Render API key', secret: true, scope: 'connection' as const },
    ],
  },
});
