# Admission: the gates that are ours to clear, not the operator's

Most of what stands between an operator and a working connection is theirs to clear, and the
manifest already says how: Box wants an OAuth app, GitHub wants a token, Apple wants an
app-specific password. Those are steps, and a `setup` block is a walkthrough of them.

This page is the other kind. Some vendors admit **clients**, not users — they run a programme, a
catalogue, a preview, or a review, and until Lanes is through it there is nothing an operator can
type that changes the answer. The distinction matters because the two failures look identical from
a terminal, and only one of them is worth an operator's afternoon.

Kept here rather than on the docs site because it is a register of where we stand with other
companies, it goes stale in ways a release does not fix, and its audience is whoever is deciding
what to work on next.

## The register

| Providers | The gate | Where we stand | What clears it |
|---|---|---|---|
| Google REST — `gmail`, `drive`, `sheets`, `docs`, `calendar`, `contacts`, `google_tasks` | Sensitive and restricted scopes on an unverified project. **100 accounts for the lifetime of the project**, not resettable, plus an unverified-app interstitial on every consent screen. | Published "In production" and unverified. The broker's `/config` reports consumption so the CLI can warn before the ceiling, and a `status` it controls can close the tap. | Google verification: annual, project-wide, and for restricted scopes a third-party security assessment measured in months. See [ADR-028](adr/028-a-hosted-oauth-client-is-the-default.md) and [ADR-031](adr/031-sign-in-and-data-access-are-separate-projects.md). |
| `gmail_mcp` | Google Workspace **Developer Preview** enrolment. | Not enrolled. Demonstrated not to be a scope problem: with all five advertised scopes granted, `tools/list` succeeds and every `tools/call` answers "The caller does not have permission". | Enrolment. Recorded in [`src/providers/google/gmail-mcp/index.ts`](../../src/providers/google/gmail-mcp/index.ts). |
| `figma` | The **Figma MCP Catalogue**. Only catalogued MCP clients may connect; a client joins by waitlist, not by registering. | Not listed. `connect` fails at registration and cannot get further. | A place in the catalogue. Recorded in [`src/providers/figma/index.ts`](../../src/providers/figma/index.ts). |

**The "where we stand" column is the operator's to keep current.** Nothing in the build checks it,
because nothing in this repository can see a waitlist.

**`slack` is in the same structural position and is not on the list.** It authorises against a
client Lanes operates rather than one the operator registered, so a distribution limit there would
land on this page — but none has been hit, and a row asserting one would be a guess. The eight
brokered providers are `slack` and the seven Google REST ones above.

## Google is the one with an exit

It belongs on this page because the *default* path runs through a client Lanes operates and a cap
Lanes owns — but an operator who does not want to wait has `lanes link connect <provider>
--own-client`, which registers their own and leaves the programme entirely. That is the whole
point of ADR-028 being a default rather than an architecture.

Figma has no such exit. No Figma console issues an MCP client, so `--own-client` has nothing to
point at, and this is why its manifest keeps `registration: 'dynamic'` rather than moving to
`manual` — `manual` would promise a console route that does not exist.

## Advertising a registration endpoint is not evidence of offering one

All **70** of the hosted-MCP providers in this repository advertise a `registration_endpoint` in
their authorization-server metadata. Figma advertises one too, and refuses every request to it:

| request to `api.figma.com/v1/oauth/mcp/register` | |
|---|---|
| a well-formed registration body | `403` |
| `{}` | `403` |
| no body at all | `403` |
| form-encoded | `403` |
| carrying a bearer token | `403` |
| carrying an `X-Figma-Token` | `403` |

An empty body earning the same refusal as a valid one puts the gate ahead of body validation, so
it reads nothing that could be changed. Metadata therefore tells us who *claims* to register
clients and nothing about who does, which is why this register grows by discovery — somebody tries
to connect and cannot — rather than by an audit anybody could run.

Probing the other 69 would mean POSTing a registration to 69 companies nobody asked to register
with, and leaving a client record behind at each one that answered. Not worth knowing that way.

## What is not on this page

A gate that scales with the operator's own app, rather than with ours. Discord's MESSAGE CONTENT
intent is the example: under 10,000 servers it is a toggle, above it a review — but the app is the
operator's, the token is theirs, and so is the review. It belongs in the provider's
`troubleshooting`, where it already is.

The test is who would fill in the form. If the answer is Lanes, it goes here.

## When one is cleared

Three places, and they can disagree:

1. **The manifest.** Its comment and `setup` block are what an operator reads at the moment of
   failure, and they are the reason the error does not read as their fault.
2. **The identity ledger**, `src/providers/identity-coverage.test.ts`, if the provider was listed
   there because it could not be reached rather than because its identity call is unknown. Figma
   is such an entry.
3. **This page.**
