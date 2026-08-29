# ADR-055: A connection may say where its service is

## Status

Accepted.

## Context

A provider's address is one value in its manifest. `base_url`, `endpoint`, `host` — one string,
fixed at build time, the same for everybody. That is correct for a vendor who runs one address:
Gmail is `gmail.googleapis.com` for every account there has ever been, and putting that in the
manifest is what makes a provider fifteen lines.

It is wrong for two large families, and both were unreachable as built-ins:

- **Multi-tenant SaaS whose host carries the tenant.** Zendesk is `<subdomain>.zendesk.com`,
  Shopify `<shop>.myshopify.com`, Atlassian's REST API `api.atlassian.com/ex/jira/<cloudid>`,
  Mailchimp `<dc>.api.mailchimp.com`. A built-in cannot name the address because the address is a
  property of the account.
- **Anything self-hosted.** A Nextcloud, a Gitea, a Home Assistant, a company Dovecot. Here the
  whole address belongs to the operator.

Neither was *impossible*: an operator could hand-write a YAML manifest in `providers.d/` with their
own address, and `connect custom` would help. But a manifest per instance is a thing nobody
discovers, it carries no setup walkthrough, and it made the generic case — "any IMAP mailbox" —
something we could not ship at all. Five near-identical mail providers exist in this repository for
exactly that reason.

## Decision

**A manifest may put `{placeholders}` in its connector's address, and declare what fills them.**

```yaml
connector:
  kind: dav
  base_url: https://{host}
  service: caldav
variables:
  - key: host
    label: Nextcloud server address
    description: The hostname you sign in at, with no https:// and no path.
    example: cloud.example.com
    pattern: '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
```

`connect` asks for each value and writes it to the connection's `config` — a field that already
existed on the row for exactly this kind of thing. The connector factory substitutes before
building, so **no transport changes**: a variable decides *where* a connector points and nothing
about how it speaks.

Four things fall out, and each is a decision rather than an accident.

**The value is not a credential.** A hostname is not a secret and does not belong in the secret
store. It lives in config, where it can be read, edited, and reviewed.

**A value is validated at substitution, not only at the prompt.** The default pattern admits one DNS
label or path segment and no dots. That is not cosmetic: the value is put into a URL, so an
unconstrained one chooses the host the operator's credential is sent to, and `acme.evil.test` in a
`{site}` would leave a manifest that reads as Zendesk and authenticates to somebody else. Config is
a file that can be edited by hand and is read by a deployed revision that never sees a prompt, so
the check has to live where the substitution does. A provider whose value is legitimately a whole
hostname — self-hosted, where the manifest names no domain to escape — says so with its own
`pattern`, and that pattern still refuses everything that is not a hostname.

**`defineProvider` refuses a manifest whose two halves disagree.** A placeholder nothing fills
reaches the vendor verbatim and fails as DNS, which says nothing about the real problem. A variable
nothing uses is quieter and worse: `connect` asks the operator a question, stores the answer, and
nothing ever reads it.

**A provider nobody has connected is not an error.** The factory returns no connector rather than
throwing, because every surface that lists what *could* be connected asks for one. A row that has
been configured and is wrong still throws.

## Consequences

`nextcloud_calendar`, `nextcloud_contacts` and `mailbox` ship as built-ins, which was not possible
before. `mailbox` is the general case the five named mail providers were each a special case of;
they stay, because a named provider carries the vendor's own setup steps, its message-size limit,
and the sentence about app passwords that a generic one cannot.

The multi-tenant HTTP family — Zendesk, Shopify, Salesforce — is now expressible and not yet
written. Each still needs a vendored OpenAPI document, which is the other half of an `http`
provider and unchanged by this.

`connect` gained a step, and it runs before the identity probe: settling an account means calling
the service, and there is nothing to call until the address is known. That ordering is why the
values cannot simply be written to the connection row first — the row's id is not decided until the
identity comes back — so a run with variables builds a factory of its own holding them.
