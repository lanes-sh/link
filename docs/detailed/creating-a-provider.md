# Creating a provider

**Start here: most providers are a YAML file, and this page is mostly not about them.**

A provider declares *how to reach a vendor*, not *what the vendor can do*
([ADR-008](adr/008-connectors.md)). Capabilities are discovered — from the vendor's own MCP server,
or from an OpenAPI document — so there is nothing per-endpoint to write.

`lanes link connect custom <id> --connector <kind> --auth <method>` writes one of these for you and
connects it in the same command, asking for anything it needs
([ADR-048](adr/048-declaring-a-provider-from-the-fixed-lists.md)). This page is what it writes, and
what to edit afterwards.

Drop one of these in `<workspace>/data/<profile>/providers.d/*.yaml` and it registers with no code and no rebuild — for that profile, which is the only one that can reach it ([ADR-030](adr/030-a-profile-owns-its-skills-and-manifests.md)):

```yaml
# Any MCP server — a vendor's, a colleague's, your own.
id: acme
name: Acme
connector: { kind: mcp, endpoint: https://mcp.acme.com/mcp }
auth:      { kind: oauth, registration: dynamic }
```

```yaml
# An MCP server that will not register a client for you — so you paste a token instead.
# `headers` is for configuration the *server* offers; the credential is never one of them.
id: acme_token
name: Acme
connector:
  kind: mcp
  endpoint: https://mcp.acme.com/mcp
  headers: { X-Acme-Toolsets: "issues,repos" }
auth: { kind: bearer }
setup:
  docs_url: https://acme.com/settings/tokens
  steps: ["Generate a token at https://acme.com/settings/tokens and copy it."]
  prompts:
    - { key: token, label: Acme API token, secret: true, scope: connection }
```

```yaml
# Any REST API with a spec. The method decides the bundle: GET/HEAD read, the rest write.
id: mything
name: My Thing
connector:
  kind: http
  base_url: https://api.mything.com
  openapi: ./mything.json
  operations:
    include: ["*Account*", "*Payment*"]   # keeps a large spec's tool list reasonable
auth:
  kind: header
  header: X-API-Key
setup:
  docs: "Generate a key at https://mything.com/settings/api"
  prompts:
    - key: api_key
      label: My Thing API key
      secret: true
      scope: connection        # one key per account, so the ref derives
```

```yaml
# Any mailbox. There is no spec to read — IMAP describes its extensions but
# never its operations — so the capability set comes from the protocol.
id: fastmail
name: Fastmail
connector:
  kind: imap
  host: imap.fastmail.com
  smtp: { host: smtp.fastmail.com, port: 465, starttls: false }
auth:     { kind: basic }
identity: { kind: connector }   # the account is the name the server accepted
setup:
  docs: "App password: https://app.fastmail.com/settings/security/apppw"
  prompts:
    - { key: username, label: Email address, scope: connection, field: username }
    - { key: password, label: App password, secret: true, scope: connection, field: password }
```

```yaml
# Any CalDAV or CardDAV server: Nextcloud, Radicale, Fastmail.
id: nextcloud_calendar
name: Nextcloud Calendar
connector: { kind: dav, base_url: https://cloud.example.com, service: caldav }
auth:      { kind: basic }
identity:  { kind: connector }
setup:
  prompts:
    - { key: username, label: Username, scope: connection, field: username }
    - { key: password, label: App password, secret: true, scope: connection, field: password }
```

```yaml
# A vendor whose authentication is a protocol rather than a value. The strategy
# is code and lives with the provider that owns it, so this names one that is
# already registered rather than supplying it — which is also how you point a
# connection at a vendor's sandbox. Copy the vendored spec in beside this file:
# a relative `openapi` resolves against the manifest's own directory.
id: bunq_sandbox
name: bunq (sandbox)
connector:
  kind: http
  base_url: https://public-api.sandbox.bunq.com/v1
  openapi: ./bunq.v1.json
auth:
  kind: strategy
  strategy: bunq
```

Then `lanes link connect mything`. The same schema validates a built-in, so the list in
`src/providers/index.ts` is a convenience and never a boundary.

### When the credential is a handshake

`auth: { kind: strategy }` is the escape hatch, and it is the **only** place per-vendor code is
allowed outside a `local` provider ([ADR-008](adr/008-connectors.md),
[ADR-046](adr/046-an-auth-strategy-belongs-to-its-provider.md)). Reach for it when a vendor wants
something no field can describe — bunq generates a keypair, runs a three-step handshake, signs every
request body, and signs its replies back.

A strategy is three optional methods on the provider's definition:

```ts
export const acme = defineProviderWithStrategy({
  manifest,                       // auth: { kind: 'strategy', strategy: 'acme' }
  strategy: {
    id: 'acme',
    async setup(context) { /* once, at connect. The only place `context.write` exists. */ },
    async authorize(request, context) { /* per request: sign it, add headers, renew a session */ },
    async verify(response, context) { /* optional: check a signed reply, notice a 401 */ },
  },
});
```

Three things about it are not negotiable:

**Keep it to auth.** It takes a request, not an operation. The moment a strategy branches on which
endpoint is being called, the per-endpoint translation ADR-008 removed has come back.

**`write` is setup-only.** A handshake persists what it produces; per-request code must not. The
restriction is the absence of the key rather than a rule to remember — and it is not only a
convention, because a deployed revision is granted write access on nothing for a non-OAuth provider.
Anything a request needs to save goes in `context.state`, which is namespaced to the connection and
shared across instances.

**It lives in `src/providers/<id>/strategy/`, never under `connectivity/`.** That component is held
free of vendor names by `src/architecture.test.ts`, and the seam there resolves a strategy without
knowing which one it is. A YAML manifest may name any strategy a registered provider supplies, which
is what the sandbox example above does.

### Where the credential goes

A `scope: connection` prompt is the usual case: one secret per account, and the
ref **derives** — you do not write it, because a manifest cannot name a
connection that does not exist yet.

Declare `credential_ref` instead when one secret genuinely serves every account
of the provider (a service key, where the key *is* the identity). Declare
`auth.app` when several providers of one vendor share a secret *per account* —
that is how the three iCloud providers are asked for one app-specific password
between them. The two contradict, so declaring both is refused.

**A vendored spec beats a fetched one.** `openapi:` accepts a URL, but a spec decides which paths get
called with your credential, and `connect` grants everything discovered — so prefer a local file you
have read. The Google specs ship that way; `src/providers/google/specs/vendor.ts` shows the shape.

---

## The rest of this page: local providers

Everything below is for a `local` provider — our own code, in-process. That is `example`, and it is
what memory, skills, and vault are. **If you are integrating someone else's service, you
almost certainly want a manifest above, not this.**

## Read this first

**Provider code is trusted code.** It runs in-process with core and holds its connection's
credential. There is **no provider sandbox**. Installing a third-party provider is equivalent to
running arbitrary code with access to that account, and you should treat installing one exactly as
seriously as that sounds.

What a provider *is* prevented from doing is reaching **outside its own connection** — another
connection's credentials, another provider's state, the profile token, the policy engine, or the
audit log. Those boundaries are enforced in the wrapper, not by asking providers to behave.

## The shape

```ts
import { z } from 'zod';
import { defineLocalProvider, keepKeys } from '@lanes-link/provider-sdk';

export const exampleProvider = defineLocalProvider({
  id: 'example',                 // lowercase; forms the namespace `example.echo`
  name: 'Example',
  version: '1.0.0',
  description: 'A trivial provider with no external service.',

  configSchema: z.object({}),     // provider-level settings
  connectionSchema: z.object({}), // per-connection settings

  auth: { kind: 'none' },         // the only kind a local connector may declare

  bundles: [
    { name: 'read',  description: 'Read notes.',   oauthScopes: [], capabilities: ['echo', 'get_note'], default: true },
    { name: 'write', description: 'Modify notes.', oauthScopes: [], capabilities: ['set_note'] },
  ],

  capabilities: [ /* tools, resources, prompts */ ],
});
```

`defineLocalProvider` validates eagerly, so a malformed provider fails at import rather than at first
invocation: duplicate capability names, a bundle referencing a capability that does not exist, and
OAuth without setup steps are all caught there.

`src/src/providers/example/provider.ts` is the full reference. It is deliberately small enough to read in
one sitting.

## A tool

```ts
{
  kind: 'tool',
  name: 'echo',                        // → `example.echo`, wire name `example_echo`
  title: 'Echo a message',
  description: 'Return the supplied message unchanged.',
  inputSchema: z.object({
    message: z.string().min(1).describe('Text to echo back'),
  }),
  redact: keepKeys('message'),
  async handler({ message }, context) {
    return { content: [{ type: 'text', text: `[${context.connection.key}] ${message}` }] };
  },
}
```

**Do not declare a `connection` argument.** Core injects it, populates its enum per profile from
resolved policy, and resolves it to `context.connection` before your handler runs. That is
[ADR-001](adr/001-connection-routing.md), and keeping it out of provider code is what lets one tool
set serve any number of accounts.

**Return a tool error rather than throwing** when the failure is something the agent should read and
react to — a missing record, a bad identifier. A thrown exception is contained and audited, but it
reaches the agent as a failure rather than as information:

```ts
return { content: [{ type: 'text', text: `No note "${key}".` }], isError: true };
```

## A resource

Use a resource for read-oriented context addressed by a stable identifier; use a tool for actions and
parameterised queries. Decide per capability and record the reasoning in `docs/detailed/providers.md` —
[ADR-006](adr/006-tools-resources-prompts.md).

```ts
{
  kind: 'resource',
  name: 'note',
  description: 'A stored note, addressed by key.',
  uriTemplate: 'example://note/{key}',
  mimeType: 'text/plain',
  async list(context) { /* enumerate; omit when the space is unbounded */ },
  async read(uri, params, context) {
    const value = await context.state.get(`note:${params['key']}`);
    if (value === null) throw new Error(`No note "${params['key']}"`);
    return { uri, mimeType: 'text/plain', text: value };
  },
}
```

Use a **prompt** for a reusable procedure — something invoked, whose result *becomes* the
conversation rather than data the model reasons about. The discriminator against a resource is
whether the answer depends on arguments; a resource is a function of its URI alone
([ADR-012](adr/012-owner-layer-primitives.md)).

```ts
{
  kind: 'prompt',
  name: 'review-diff',
  description: 'Review a diff for correctness.',
  arguments: [{ name: 'diff', description: 'The unified diff', required: true }],
  async render(args, context) {
    return { messages: [{ role: 'user', text: `Review this diff:\n\n${args['diff']}` }] };
  },
}
```

`skills` is the only provider using it so far, and it holds the primitive's one real caution:
a prompt's messages enter the conversation as turns, so what a prompt renders shapes what the agent
does next. Do not render text a caller supplied without deciding that is what you meant.

**Routing is handled for you in all three cases.** A tool gets `profile` and `connection` injected as
arguments; a resource gets them inserted into its URI, so your `read` receives only the variables you
declared and your `list` may return your own unrouted URIs; a prompt gets them as optional arguments
that default when there is one candidate. A provider never learns which account it is serving beyond
`context.connection` — that is ADR-001, and it is why a `resource_link` you return is rewritten to a
routed address before it reaches the client.

## What your handler is given

```ts
interface ProviderContext {
  connection: ConnectionInfo;   // id, key, displayName, validated config
  state: ScopedStore;           // namespaced to <provider>/<connection>
  storage: BlobStore;           // same namespace
  credentials: ScopedCredentials; // read-only, this connection's refs only
  audit: AuditLogger;           // annotate this invocation; cannot read the log
  log: Logger;                  // prefixed with provider and connection
  signal: AbortSignal;
}
```

Seven keys, and nothing else. No `Database`, no config, no policy engine, no registry — see
[ADR-007](adr/007-control-plane-exclusions.md), which has a test pinning that exact set.

`state` and `storage` are already namespaced, so there is no key you can construct that reaches
another provider or another connection. `credentials` is restricted to an allowlist computed from
what your connection declares; asking for anything else throws, and an out-of-scope ref fails
identically to a missing one.

## Redaction is your responsibility

Every invocation is audited. What lands in the log is whatever your `redact` rule returns.

**The default withholds every value**, recording argument names and value types only. Opt in
deliberately:

```ts
redact: keepKeys('key')   // the key is useful and harmless; the value is the content
```

`redact` is available on every capability kind, not just tools — a resource read is dispatched with
its URI as an argument, and an address is exactly as worth recording, or withholding, as a message
id.

For a secret, `keepKeys` is not enough: it reduces an unkept value to `<string:40>`, and a length is
a real disclosure. Use `redaction` when you need both halves:

```ts
redact: redaction({ keep: ['id'], withhold: ['value'] })   // '<withheld>', not '<string:40>'
```

A search query routinely contains the very content the caller may not be allowed to read. A message
id is useful and harmless. Think about which yours is — and note that the rule is applied to
**denials too**, so a refused call cannot leak through the log what an allowed one would have hidden.

`context.audit.annotate({ bytes: value.length })` adds provider-specific detail. Whatever you pass is
persisted verbatim, so redact it yourself.

## Declaring credentials

```ts
credentialRefs(connectionId, config) {
  return [`gmail/${connectionId}`, 'google/client_secret'];
}
```

Core turns this into the allowlist behind `context.credentials`. If you declare nothing, the
connection's own `credential_ref` is the entire allowlist.

## Setup steps

For anything needing credentials, declare how an operator obtains them. The CLI renders whatever you
declare, which is how `lanes link connect <provider>` stays one command and how core avoids ever learning
what your provider is:

```ts
setup: {
  summary: 'Gmail needs a Google Cloud OAuth client that you register yourself.',
  docsUrl: 'https://console.cloud.google.com/apis/credentials',
  steps: [
    'Create a project at console.cloud.google.com',
    'Create an OAuth client of type "Desktop app"',
    'Move the app out of "Testing" publishing status',
  ],
  prompts: [
    { key: 'client_id',     label: 'Client ID',     secret: false, credentialRef: 'google/client_id' },
    { key: 'client_secret', label: 'Client secret', secret: true,  credentialRef: 'google/client_secret' },
  ],
}
```

Only the `_ref`s reach the config file; values go to the credential store.

## Bundles

A bundle maps one name onto both layers that "permission" means:

```ts
{ name: 'read', oauthScopes: ['gmail.readonly'], capabilities: ['search', 'get_message'], default: true }
```

These behave differently, and the difference is not cosmetic: **`oauthScopes` are what the vendor
grants us, and widening them requires browser re-consent**, while `capabilities` are what an agent
may invoke and are purely local. Tightening is free; widening needs consent.

`lanes link connect` requests the default bundle and writes the matching allow lines into the config, showing
you the diff. That does not weaken default deny — the runtime is still deny-unless-listed; the file
is pre-populated rather than hand-typed.

## Registering it

Built-in providers are statically imported in `src/cli/runtime.ts`. Nothing in the registry
assumes that, so independently versioned packages remain possible.

The ids `memory`, `skills`, and `vault` are **reserved** for the owner layer and are still refused at
registration — the guard was never about the layer being unbuilt, and reclaiming a namespace once
providers exist in the wild would silently change what a policy rule means. Only the built-in
registry opts in.

## Testing

No server, no policy layer, no transport — build a context, call a handler, assert on the result.
`src/providers/example/src/index.test.ts` doubles as the worked example, and it covers the parts worth
covering: that a missing record is a tool error rather than a throw, that state is per connection,
that redaction withholds what it should, and that no capability declares a `connection` argument.
