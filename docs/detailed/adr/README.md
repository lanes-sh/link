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
- **ADR-019** does not supersede ADR-007. It records why a *read-only* setup surface is outside
  those exclusions — the rule is about authorisation, not information — and names the two things
  that keep it there: it reports only what policy already permits, and it never reports whether a
  credential is present.
