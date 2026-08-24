/**
 * The scaffold `lanes link` writes, one per connectivity type.
 *
 * A custom provider is the same declaration a built-in is — this is the *only*
 * difference between `#providers/google/gmail/` and a file an operator drops in
 * their profile's `providers.d/`, and the point of the whole manifest design.
 * So the template offers one starting point per `connector.kind` rather than a
 * single generic one that would have to be edited into shape.
 */

export function manifestTemplate(kind: 'mcp' | 'http' | 'imap' | 'dav' | 'fs'): string {
  if (kind === 'mcp') {
    return `# A custom MCP server — a vendor's, a colleague's, or your own.
#
# If the server supports Dynamic Client Registration there is nothing else to
# do: Lanes Link registers itself when you run \`lanes link connect\`.
id: acme
name: Acme
description: Whatever this server exposes.

connector:
  kind: mcp
  endpoint: https://mcp.acme.com/mcp

auth:
  kind: oauth
  registration: dynamic     # or "manual" if the vendor makes you register an app
`;
  }

  if (kind === 'imap') {
    return `# Any mailbox: Fastmail, mailbox.org, a company Dovecot.
#
# There is no spec to read — IMAP describes its extensions but never its
# operations — so the capability set is fixed by the protocol. Reading never
# marks mail as read, and nothing here can delete any.
id: fastmail
name: Fastmail

connector:
  kind: imap
  host: imap.fastmail.com
  port: 993
  smtp:
    host: smtp.fastmail.com
    port: 465
    starttls: false        # 465 is implicit TLS; 587 upgrades in-band

auth:
  kind: basic              # a username and an app password, per account

identity:
  kind: connector          # the account is the name the server accepted

setup:
  docs: "Create an app password at https://app.fastmail.com/settings/security/apppw"
  prompts:
    - key: username
      label: Email address
      scope: connection
      field: username
    - key: password
      label: App password
      secret: true
      scope: connection
      field: password
`;
  }

  if (kind === 'fs') {
    return `# A folder on this machine — iCloud Drive, Dropbox, a project directory.
#
# No credential: the permission is the operating system's, so this only works
# where the files actually are. Everything under the root is reachable and
# nothing above it is, symlinks included.
id: dropbox
name: Dropbox

connector:
  kind: fs
  root: ~/Dropbox
  max_file_bytes: 262144     # one read; a large file is refused rather than truncated
  exclude: []                # on top of .git, .ssh, node_modules, which are always refused

auth:     { kind: none }
identity: { kind: connector }
`;
  }

  if (kind === 'dav') {
    return `# Any CalDAV or CardDAV server: Nextcloud, Radicale, Fastmail.
#
# Discovery walks .well-known, then the principal, then the collection home —
# and remembers the result per account, since many servers answer from a
# per-user host.
id: nextcloud_calendar
name: Nextcloud Calendar

connector:
  kind: dav
  base_url: https://cloud.example.com
  service: caldav          # or carddav, for contacts

auth:
  kind: basic

identity:
  kind: connector

setup:
  docs: "Use an app password from Settings → Security."
  prompts:
    - key: username
      label: Username
      scope: connection
      field: username
    - key: password
      label: App password
      secret: true
      scope: connection
      field: password
`;
  }

  return `# A REST API described by OpenAPI.
#
# Operations become capabilities automatically — GET and HEAD land in the
# "read" bundle (granted by default), everything else in "write".
id: acme
name: Acme
description: Whatever this API exposes.

connector:
  kind: http
  base_url: https://api.acme.com/v1
  openapi: https://api.acme.com/openapi.json   # a URL, or a path in this workspace
  operations:
    # A large spec yields hundreds of tools, which no agent can reason over.
    # Narrow it by operationId, path, or tag.
    include: ["*Account*", "*Payment*"]
    exclude: []

auth:
  kind: header
  header: X-API-Key
  credential_ref: acme/api_key      # a reference; never the key itself

setup:
  docs: "Generate a key at https://acme.com/settings/api"
  prompts:
    - key: api_key
      label: Acme API key
      secret: true
      credential_ref: acme/api_key
`;
}
