# Architecture decision records

These decisions were made in `docs/detailed/init.md` and are transcribed here with their reasoning. They are
not open questions; changing one means revisiting the reasoning, not re-litigating the choice.

The exception is marked as one. **ADR-025 is proposed rather than accepted** — it is a question
with the case already argued, filed here so the next person to ask does not start from nothing.
Nothing in the codebase depends on it.

| | Decision |
|---|---|
| [001](001-connection-routing.md) | Connection identity is a tool argument, never part of the tool name |
| [002](002-transport-and-statelessness.md) | Stateless streamable HTTP on MCP SDK v2, protocol `2026-07-28` |
| [003](003-auth-model.md) | One token per profile; policy lives at the profile level |
| [004](004-declarative-config.md) | Declarative config, imperative CLI |
| [005](005-oauth-connection-flow.md) | The CLI performs the OAuth exchange, over a loopback redirect |
| [006](006-tools-resources-prompts.md) | Tools, resources, and prompts are decided per capability |
| [007](007-control-plane-exclusions.md) | Control-plane operations are unreachable from MCP |
| [008](008-connectors.md) | A provider is a manifest, not a package |
| [009](009-one-endpoint-per-workspace.md) | One endpoint serves every profile |
| [010](010-non-http-connectors.md) | Connector kinds for protocols that are not HTTP |
| [011](011-local-filesystem.md) | A local folder is a connector kind; the cloud answer is a relay |
| [012](012-owner-layer-primitives.md) | Skills are prompts, memory writes are separate, vault items are capability names |
| [013](013-one-cloud-host.md) | One cloud host supplies both stores; adapters are named for the protocol |
| [014](014-owner-layer-is-managed.md) | Skills can be written under policy; all three owner stores follow the target |
| [015](015-one-package-under-src.md) | One package under `src/`; a provider owns its vendor code; an architecture test replaces the package graph |
| [016](016-what-the-endpoint-says-about-itself.md) | The endpoint describes itself in `instructions`; `mcp add` writes the documents no harness has a command for |
| [017](017-attachments-by-reference.md) | An attachment is named, not carried, so its bytes never pass through the model; and a remote provider may author a capability its vendor's document cannot express |
| [018](018-the-gate-is-in-the-application.md) | A deployed instance is gated inside the application rather than by the platform's front door, and issues its own tokens by default |
| [019](019-describing-setup-is-not-performing-it.md) | A read-only setup surface describes what connecting involves; describing setup authorises nothing, so the control-plane wall has not moved |
| [020](020-the-log-is-objects.md) | The audit log is one object per event, hash-chained, in the same layout locally and deployed |
| [021](021-no-database.md) | There is no database: runtime state is one object per key in the blob store |
| [022](022-the-vault-rides-secret-manager.md) | The vault document is one entry in the secret store, sealed under its own key |
| [023](023-the-workspace-is-not-in-the-image.md) | The workspace is not baked into the image; `LANES_LINK_HOME` may be a bucket |
| [024](024-telemetry-is-a-copy.md) | Extra audit sinks are copies; the durable log is never a network call |
| [025](025-connecting-an-account-from-a-deployed-endpoint.md) | **Proposed, not decided.** Whether a deployed endpoint may run the OAuth flow itself — the mechanical objection has expired, the authorisation one has not |
| [026](026-a-revision-rotates-its-own-credentials.md) | A revision may add a version to each secret it rotates, and may still never create one |
| [028](028-a-hosted-oauth-client-is-the-default.md) | A client Lanes operates is what `connect` uses by default; `--own-client` registers your own |
| [029](029-connecting-is-not-deploying.md) | Connecting publishes its own config and the endpoint re-reads it; deploying is only code |
| [030](030-a-profile-owns-its-skills-and-manifests.md) | Skills and provider manifests move into `data/<profile>/`; nothing is shared between profiles any more |
| [031](031-sign-in-and-data-access-are-separate-projects.md) | Signing in and reaching Google data are separate Cloud projects; the second is where every Google-data client goes |
| [032](032-a-stateless-endpoint-does-not-announce-its-tools.md) | `listChanged` is declared false because it is false; a reload reports its tool count and `lanes link tools` asks the endpoint |
| [033](033-a-pasted-token-for-an-mcp-server.md) | Where a vendor's MCP server will not register a client, the operator's own token is the credential — so an mcp connector's auth is exactly none, oauth, or bearer |
| [034](034-updating-is-a-reinstall.md) | Updating is replacing the installed package; Bun is the only installer driven, a checkout is refused, and nothing updates itself |
| [035](035-a-replayed-refresh-token-must-not-log-the-owner-out.md) | A replayed refresh token is refused on its own and recorded; the family it belongs to survives |
| [036](036-a-client-is-told-this-endpoint-keeps-it-signed-in.md) | `offline_access` is advertised and granted, a rejected credential is told `invalid_token`, and scope is narrowed rather than echoed |
| [037](037-a-command-names-what-it-acts-on.md) | A command names its profile and target as flags, or it does not run; the environment variables and config defaults are parsed and no longer read |
| [038](038-a-key-is-the-second-way-into-an-account.md) | A service account key is a second way into a Google account, for the consent nobody can give a background job |
| [039](039-cross-origin-access-is-a-deployment-only-grant.md) | Cross-origin access is granted only by a deployment, and a preflight is answered ahead of the credential check |
| [040](040-an-mcp-connector-may-use-a-pre-registered-client.md) | An `mcp` connector that names its own endpoints may be brokered, and a vendor that refuses a loopback redirect gets one bounced through the broker — so Slack costs a browser round trip rather than a console visit |

Where an ADR departs from init.md, it says so at the top. Three are significant:

- **ADR-003** replaces init.md's per-client policy model.
- **ADR-009** supersedes part of ADR-003 and reduces what the system guarantees: profiles no longer
  have separate URLs or separate tokens. It says so plainly rather than describing itself as a
  refactor, because the mitigation is unbuilt.
- **ADR-014** supersedes ADR-012 §1's refusal of a skill write path. It does not withdraw that
  argument — it withdraws the conclusion that structural absence was the only safe answer, and
  adopts the one ADR-012 §2 already used for `memory.write`.
- **ADR-018** amends ADR-003 and replaces init.md's "optionally behind Cloud Run IAM" (M3, point 5).
  IAM in front of the endpoint is not a second layer over the bearer token — it is an alternative
  that excludes every remote MCP client, so the gate moved into the application instead.
- **ADR-028** amends ADR-005's step 2, "read the provider's `oauth_app` entry and resolve the client
  id and secret … prompting for them on first use", which stops being the default. Everything else
  in ADR-005 survives — the CLI still runs the flow, the listener is still loopback, the browser
  still talks to the vendor, the server still never participates. What moves is who holds the
  client secret, and therefore where the code becomes a token.
- **ADR-019** does not supersede ADR-007. It records why a *read-only* setup surface is outside
  those exclusions — the rule is about authorisation, not information — and names the two things
  that keep it there: it reports only what policy already permits, and it never reports whether a
  credential is present.
- **ADR-030** supersedes ADR-012 §1's storage location and part of ADR-014 §2, and is the only
  departure that makes the system guarantee *more* than it did: ADR-009's "profiles share no
  database and no credential store" had two exceptions left in it, and now has none. The half of
  ADR-012 §1 that survives is the one about self-selection — reading a skill's body stays in the
  author bundle.
- **ADR-029** amends ADR-004's "exposes no administrative API", which stops being true: there is one
  authenticated route that is not `/mcp`. The clause that carried the weight survives intact — a
  deployed instance still never mutates its own configuration, and `/reload` takes no parameters, so
  the only thing it can be asked for is a re-read of what the CLI already wrote. It also supersedes
  ADR-019's "a new connection is not served until the endpoint restarts", which named this as a
  decision someone would have to take, and pays one of the five costs ADR-025 listed as blocking.

- **ADR-035** supersedes the replay half of ADR-018, and is the second record here to make the
  system guarantee *less* than it did. ADR-018 chose to issue tokens in the application and to
  answer a replayed refresh token by revoking its whole chain; the issuing stands and the answer
  does not. What changed is evidence rather than reasoning: a family is minted once and never
  rotates, so the expensive answer was reaching an approved client roughly daily and a thief never.

- **ADR-036** completes ADR-035 rather than amending it. ADR-035 removed the endpoint's own reason
  for logging a connector out; this one removes the reason a client had for not refreshing. Both
  were needed and neither was sufficient, which is the shape worth remembering: the endpoint was
  correct and the client was correct, and the session still ended at a consent screen.

- **ADR-037** withdraws half of an argument rather than reversing it. The claim that persisted
  selection is how operators act on the wrong thing still stands, and is why the rule exists; what
  did not survive is the conclusion that making the fallback *visible* was enough. A printed line
  is not a guard, and a fallback made an ignored flag survivable — so the mistake surfaced one
  command later, from a different source, detached from its cause.

- **ADR-038** follows from ADR-028 rather than amending it: the hosted client stays the default and
  the browser stays the ordinary route. What it corrects is a claim ADR-028's implementation made
  and could not keep — that a hosted client escapes the seven-day refresh-token expiry — and what
  it adds is the only arrangement that genuinely does, which is a credential nobody consented to.
