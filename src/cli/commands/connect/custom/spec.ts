/**
 * The two fixed lists, as data, and what each member needs typed.
 *
 * `connect custom` exists to compose them: a connectivity type from
 * `connectivity/manifest/connector.ts` and a credential type from
 * `connectivity/manifest/auth.ts`, which are closed discriminated unions. So
 * this file is a projection of those two schemas onto flags, and nothing here
 * decides anything — `derive.ts` builds the manifest and `defineProvider` has
 * the final word, exactly as it does for a hand-written file.
 *
 * One member is deliberately absent. `local` means the capability code is
 * *ours*, compiled into this build, so there is nothing for a manifest to point
 * at — refused by name rather than omitted in silence, because an operator
 * reading the schema will find it and ask.
 *
 * `strategy` *is* offered, and naming one is a large part of what a declaration
 * is for. A strategy travels on a provider's definition rather than in a global
 * registry, so a YAML manifest reaches one by name — which is the only way to
 * point a connection at a vendor's sandbox, since a built-in manifest's
 * `options` are not the operator's to edit. See ADR-046.
 */

/** Reachable by declaring one. `local` is ours; see the note above. */
export const CONNECTOR_KINDS = ['mcp', 'http', 'imap', 'dav', 'fs'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/**
 * Typed with a hyphen, stored with an underscore.
 *
 * The manifest spells it `api_key` because `identifier` does, and a flag spells
 * it `api-key` because every other flag in this CLI is kebab-case. One place
 * knows both.
 */
export const AUTH_METHODS = [
  'none',
  'bearer',
  'api-key',
  'header',
  'basic',
  'oauth',
  'strategy',
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const AUTH_KIND: Record<AuthMethod, string> = {
  none: 'none',
  bearer: 'bearer',
  'api-key': 'api_key',
  header: 'header',
  basic: 'basic',
  oauth: 'oauth',
  strategy: 'strategy',
};

/**
 * Provider ids this command's own grammar has taken.
 *
 * `custom` is the second word of `lanes link connect custom`, so a provider
 * called `custom` could be declared, registered, and then never connected —
 * that command would always mean this one. Refused in two places: here, so it
 * cannot be created, and in `buildRegistryWithWorkspace`, so a file written by
 * hand before this existed says why rather than being quietly unreachable.
 *
 * Not `RESERVED_PROVIDER_IDS`: that list is the owner layer's, it is surfaced to
 * an agent as "the owner providers present in this profile", and the CLI
 * registry passes `allowReserved: true` so it would not have fired here anyway.
 */
export const RESERVED_BY_GRAMMAR = ['custom'] as const;

/** One value the operator supplies, and what to call it when asking. */
export interface FieldSpec {
  /** The kebab-case flag, which is also the key in `CustomFlags` once camelised. */
  readonly flag: string;
  readonly label: string;
  readonly required: boolean;
  /** One line under the prompt, where the answer is not obvious from the label. */
  readonly hint?: string;
  /** A closed set, offered as a choice rather than a free string. */
  readonly choices?: readonly string[];
}

/**
 * Per connectivity type: what must be said, and what may be.
 *
 * Only fields with no honest default appear. `port`, `max_body_bytes`,
 * `max_range_days`, `max_file_bytes` and the rest are schema defaults and stay
 * out of the written file, so a later change to a default reaches manifests
 * already on disk instead of being frozen into each one.
 */
/**
 * The one field `mcp` and `http` share, and the only one worth a flag.
 *
 * Repeatable. What the *vendor* requires of a client rather than what a caller
 * wants from it: a `User-Agent` on a host that throttles the default one
 * hardest, or the header an mcp server offers for asking it to expose fewer
 * tools. `Authorization` is refused — that one belongs to `auth`.
 */
const HEADER: FieldSpec = {
  flag: 'header',
  label: 'Header sent on every request',
  required: false,
  hint: 'Name: value, repeatable. For what the vendor requires of a client, e.g. a User-Agent',
};

export const CONNECTOR_FIELDS: Record<ConnectorKind, readonly FieldSpec[]> = {
  mcp: [
    {
      flag: 'endpoint',
      label: 'MCP endpoint',
      required: true,
      hint: 'The URL the server speaks Streamable HTTP on, e.g. https://mcp.example.com/mcp',
    },
    HEADER,
  ],
  http: [
    { flag: 'base-url', label: 'Base URL', required: true, hint: 'e.g. https://api.example.com/v1' },
    {
      flag: 'openapi',
      label: 'OpenAPI document',
      required: true,
      hint: 'A URL, or a path to a file beside the manifest',
    },
    {
      flag: 'operations',
      label: 'Operations to expose',
      required: false,
      hint: 'Globs on operationId, path or tag. A large spec is a tool list no agent can reason over',
    },
    HEADER,
  ],
  imap: [
    { flag: 'host', label: 'IMAP host', required: true, hint: 'e.g. imap.example.com' },
    { flag: 'port', label: 'IMAP port', required: false, hint: 'Defaults to 993' },
    {
      flag: 'smtp-host',
      label: 'SMTP host',
      required: false,
      hint: 'Leave empty for a read-only mailbox — without it there is no send capability',
    },
    { flag: 'smtp-port', label: 'SMTP port', required: false, hint: '465 for implicit TLS, 587 to upgrade in-band' },
  ],
  dav: [
    { flag: 'base-url', label: 'Base URL', required: true, hint: 'Where discovery begins, e.g. https://dav.example.com' },
    { flag: 'service', label: 'Service', required: true, choices: ['caldav', 'carddav'] },
  ],
  fs: [
    { flag: 'root', label: 'Folder', required: true, hint: 'Everything under it is reachable and nothing above it. May start with ~' },
    { flag: 'exclude', label: 'Names to exclude', required: false, hint: 'On top of .git, .ssh and node_modules, which are always refused' },
  ],
};

/**
 * Per credential type.
 *
 * The credential itself is never here, and never a flag. A flag value is in
 * shell history, in `ps` output while the command runs, and in any transcript of
 * the session — which is why `secrets set` reads from stdin and why this command
 * writes `setup.prompts` into the manifest and lets the ordinary connect path
 * ask. The upshot is that this change handles no secrets at all.
 */
export const AUTH_FIELDS: Record<AuthMethod, readonly FieldSpec[]> = {
  none: [],
  bearer: [
    { flag: 'auth-header', label: 'Header name', required: false, hint: 'Defaults to Authorization' },
  ],
  'api-key': [
    { flag: 'auth-header', label: 'Header name', required: false, hint: 'Defaults to X-API-Key' },
    { flag: 'auth-query', label: 'Query parameter', required: false, hint: 'Instead of a header' },
  ],
  header: [
    { flag: 'auth-header', label: 'Header name', required: true, hint: 'The header the value is sent in, verbatim' },
  ],
  basic: [],
  strategy: [
    {
      flag: 'strategy',
      label: 'Strategy name',
      required: true,
      hint: 'The name a provider in this build supplies, e.g. bunq',
    },
    {
      flag: 'strategy-option',
      label: 'Strategy option',
      required: false,
      hint: 'key=value, repeatable. Read by the strategy itself',
    },
  ],
  oauth: [
    { flag: 'scopes', label: 'Scopes', required: true, hint: 'What to ask the authorization server for' },
    { flag: 'authorize-url', label: 'Authorize URL', required: false, hint: 'Required for an http connector; discovered for mcp' },
    { flag: 'token-url', label: 'Token URL', required: false, hint: 'Declared with authorize-url or not at all' },
    { flag: 'client-app', label: 'OAuth app name', required: false, hint: 'Which oauth_apps entry holds the client. Defaults to the provider id' },
    { flag: 'registration', label: 'Registration', required: false, choices: ['dynamic', 'manual'] },
    {
      flag: 'authorize-param',
      label: 'Extra authorization parameter',
      required: false,
      hint: 'key=value, repeatable. Some vendors need one to issue a refresh token at all',
    },
    {
      flag: 'redirect-uri',
      label: 'Redirect URI',
      required: false,
      hint: 'Only for a vendor that matches the whole URL — connect otherwise uses a port the kernel picks',
    },
  ],
};

/** Everything `connect custom` accepts, including what it forwards to `connect`. */
export const CONNECT_CUSTOM_FLAGS: readonly string[] = [
  'connector',
  'auth',
  'name',
  'description',
  ...new Set(
    [...Object.values(CONNECTOR_FIELDS), ...Object.values(AUTH_FIELDS)]
      .flat()
      .map((field) => field.flag),
  ),
  'identity-url',
  'identity-field',
  'setup-docs',
  'replace-manifest',
  'yes',
  // Forwarded to `connect` untouched, so declaring and connecting is one line.
  // `--own-client` is not among them: it selects between an operator's client
  // and a broker's, and a synthesized manifest never declares a broker.
  'id',
  'display-name',
  'label',
  'replace',
  'non-interactive',
  'accept-broad-scopes',
];

/** What the operator typed, before any of it has been judged. */
export interface CustomFlags {
  readonly connector?: string | undefined;
  readonly auth?: string | undefined;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly openapi?: string | undefined;
  readonly operations?: readonly string[] | undefined;
  readonly service?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: string | undefined;
  readonly smtpHost?: string | undefined;
  readonly smtpPort?: string | undefined;
  readonly root?: string | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly header?: readonly string[] | undefined;
  readonly authHeader?: string | undefined;
  readonly authQuery?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly authorizeUrl?: string | undefined;
  readonly tokenUrl?: string | undefined;
  readonly clientApp?: string | undefined;
  readonly registration?: string | undefined;
  readonly redirectUri?: string | undefined;
  readonly authorizeParam?: readonly string[] | undefined;
  readonly strategy?: string | undefined;
  readonly strategyOption?: readonly string[] | undefined;
  readonly identityUrl?: string | undefined;
  readonly identityField?: string | undefined;
  readonly setupDocs?: string | undefined;
  readonly replaceManifest?: boolean | undefined;
  readonly yes?: boolean | undefined;
}

/** Everything settled, ready for `deriveManifest`. */
export interface CustomAnswers {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly connector: ConnectorKind;
  readonly auth: AuthMethod;
  readonly values: Readonly<Record<string, string | readonly string[]>>;
}

/** `acme_billing` reads as `Acme Billing` until somebody says otherwise. */
export function titleCase(id: string): string {
  return id
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** camelCase, so a flag name indexes `CustomFlags` without a second table. */
export function camel(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
