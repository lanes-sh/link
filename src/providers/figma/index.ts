import { defineProvider } from '#connectivity';

/**
 * Figma, through the server Figma runs — and will not register us with.
 *
 * `api.figma.com` advertises a `registration_endpoint` and then refuses every
 * request made to it with a bare `403 Forbidden`: an empty body earns the same
 * refusal as a well-formed one, so the gate sits ahead of body validation, and
 * neither a bearer token nor an `X-Figma-Token` moves it. Figma's own
 * documentation says why — only clients listed in its MCP catalogue may
 * connect, and a new client joins by waitlist. So this is an allowlist, not a
 * plan to upgrade, a scope to widen, or a session to sign in to. There is no
 * request that gets through.
 *
 * `registration` stays `dynamic` anyway, for two reasons. It is what Figma
 * advertises and what we correctly attempt, and the day a client of ours is in
 * that catalogue the declaration becomes true with nothing here to change.
 * `manual` would be worse than imprecise: it promises an operator can supply a
 * client of their own, and for an MCP client at Figma no console issues one.
 * The honest third state — the vendor allowlists clients and offers no
 * self-serve route — is not a value this field has, and `manifest/auth.ts`
 * argues against growing it for one vendor. Prose carries it until a second
 * vendor does the same.
 *
 * What the setup block is for: `connect/registration.ts` reads `docs_url` when
 * a registration is refused, so the refusal points at the page that explains
 * itself rather than at a bare hostname. It declares no prompts and so asks for
 * nothing — `ensureOAuthApp` returns before rendering it, this provider naming
 * no `app`.
 */
export const figma = defineProvider({
  id: 'figma',
  name: 'Figma',
  description: 'Files, designs, components, and Dev Mode context, via Figma\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.figma.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
  setup: {
    summary:
      'Figma admits only the MCP clients listed in its own catalogue, and a client joins that list ' +
      'by waitlist rather than by registering. Nothing is asked for here because there is nothing ' +
      'to paste: registration is refused before anything about your account is looked at.',
    docs_url: 'https://developers.figma.com/docs/figma-mcp-server/',
    troubleshooting:
      'A 403 from the registration endpoint is the catalogue and not your account — the same ' +
      'request is refused signed in, signed out, and with no body at all. Figma also ships a ' +
      'desktop MCP server that needs no registration; it is a different endpoint, not this one.',
  },
});
