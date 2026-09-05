# Architecture decision records

These decisions were made in `docs/detailed/init.md` and are transcribed here with their reasoning. They are
not open questions; changing one means revisiting the reasoning, not re-litigating the choice.

The exceptions are marked as such. **ADR-025 is proposed rather than accepted** — a question with
the case already argued, filed here so the next person to ask does not start from nothing. Nothing
in the codebase depends on it.

ADR-062 and ADR-063 were both filed as proposals while 0.8.0's first half was being shaped around
them. Both are now accepted and built: `/authorize` redirects to lanes.sh and the consent form that
asked for a pasted token is gone, and `lanes link pair` provisions a TLS read listener one port
above the endpoint that exactly one browser origin may read. **ADR-064 is accepted and built too**,
and finishes that sentence for the other half of the audience: the same two routes now answer on a
deployed endpoint's own URL, so `pair` works whether the workspace is on this machine or on Cloud
Run.

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
| [041](041-memory-and-skills-in-a-repository.md) | Memory and skills may be kept in a GitHub repository; the vault, the credential store, state and the log may not |
| [042](042-a-profile-declares-who-its-owner-is.md) | A profile declares who its owner is, so an agent writing on their behalf stops guessing |
| [043](043-a-target-scoped-command-acts-on-the-target.md) | A command whose subject is the endpoint acts on the target, and every profile declaring it |
| [044](044-a-deployment-records-where-it-lives.md) | A deployment records where it lives outside any profile, and the two copies of a workspace can be merged |
| [045](045-a-redirect-the-vendor-matches-exactly.md) | A provider may name the loopback redirect verbatim, for a vendor that matches `redirect_uri` exactly rather than ignoring the port |
| [046](046-an-auth-strategy-belongs-to-its-provider.md) | An auth strategy belongs to its provider, and its session is state |
| [047](047-a-pasted-token-carries-its-own-scheme.md) | A pasted token may carry its own auth scheme in the stored value, and a vendored write surface may return a credential to the caller where the alternative is losing the capability |
| [048](048-declaring-a-provider-from-the-fixed-lists.md) | A provider is declared by composing the two fixed lists — one connectivity type, one credential type — and connected in the same command |
| [049](049-manifests-are-read-through-the-workspace-store.md) | A profile's manifests are read through its store, so a custom provider serves from a deployed endpoint |
| [050](050-the-owner-layer-is-granted-by-default.md) | The owner layer is granted by default, because nothing behind it is an account |
| [051](051-tasks-and-assets-are-their-own-stores.md) | A task and a file are each their own store, not a memory entry |
| [052](052-a-target-owns-its-workspace.md) | A target owns its workspace, and a profile lives in exactly one |
| [053](053-the-page-a-person-reads-is-the-app.md) | The page a person reads is the desktop app, and the endpoint stops serving one |
| [054](054-the-surface-in-front-of-the-gate.md) | The surface in front of the gate is metered, and does not name itself |
| [055](055-a-connection-may-say-where-its-service-is.md) | A connection may say where its service is, so a self-hosted or multi-tenant host can be a built-in |
| [056](056-everyone-else-is-declared-too.md) | Everyone else is declared too, and a lookup answers with all of them |
| [057](057-a-connection-belongs-to-the-workspace.md) | A connection belongs to the workspace, and a profile selects it |
| [058](058-a-grant-names-a-connection.md) | A grant names a connection, so scopes differ per account |
| [059](059-the-owner-layer-is-instances.md) | The owner layer is instances, and two profiles may share one |
| [060](060-a-caller-is-a-person.md) | A caller is a person, and a profile declares who may consume it |
| [061](061-a-workspace-is-the-only-word.md) | A workspace is the only word, and a default may be sticky where nothing is destroyed |
| [062](062-the-consent-page-asks-lanes-who-you-are.md) | The consent page asks Lanes who you are, and the pasted token is for CI |
| [063](063-one-origin-may-read-a-loopback-endpoint.md) | One origin may read a loopback endpoint, over a certificate it installs |
| [064](064-a-deployed-endpoint-is-read-over-its-own-url.md) | A deployed endpoint is read over its own URL, and pairing stops meaning a certificate |
| [065](065-the-app-provisions-this-cli.md) | The desktop app installs and updates this CLI on its own lifecycle, and a foreign install is replaced rather than argued with |
| [066](066-a-profile-owns-its-data-again.md) | A profile owns its data again: the bytes go back in front of the connection, and two profiles granting one instance share nothing |
| [067](067-one-directory-per-profile.md) | One directory per profile, `data/` goes, and a connection id becomes opaque |
| [068](068-a-credential-names-a-person.md) | A credential names a person, and the profiles follow from that; the endpoint token becomes the workspace's |
| [069](069-a-pairing-token-may-write-the-owners-own-data.md) | A pairing token may write the owner's own data; the control plane is unmoved |
| [070](070-one-process-serves-many-workspaces.md) | One process serves many workspaces, and the boundary becomes a code path |
| [071](071-a-managed-workspace-is-a-workspace.md) | A managed workspace is a workspace, reached over the API |
| [072](072-an-environment-is-derived-not-assembled.md) | A deployment derives its environment, and a mismatch refuses to boot |
| [073](073-a-managed-endpoint-carries-a-control-surface.md) | A managed endpoint carries a control surface, and is not on the internet |

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

- **ADR-041** narrows ADR-013 rather than reopening it. That decision says one cloud host supplies
  both stores and that adapters are named for the protocol; this leaves both standing and adds a
  second, *smaller* choice beside the target's `storage:` block — where two directories of documents
  the owner wrote are kept. What it may hold is fixed by having no field for anything else: the
  credential store and the vault cannot be named by it, by a flag, or by an example somebody copies.
  It also settles the one cost ADR-030 wrote down and declined to pay.

- **ADR-048** finishes ADR-008 rather than amending it. That decision made a provider a
  declaration and said a service nobody has integrated should be a file rather than a pull
  request; the mechanism has been true since and the way in did not exist. What it adds is a
  command, and one constraint on it worth reading as part of the decision: the flags are a
  projection of the two unions, so what cannot be declared is exactly what those unions cannot
  express — never a field this command invents to route around them.

- **ADR-049** amends ADR-030 on one point. That decision moved manifests into the profile and
  named the path; it did not say how the path is read, and the filesystem read it inherited meant
  a deployed revision — whose workspace is a bucket URL — silently loaded none of them. ADR-014
  had already answered the same question for skills, and this applies that answer to the other
  directory ADR-030 created.

- **ADR-050** amends ADR-012 by changing what a profile arrives with, not what any of it can do.
  The grant it makes default is the one `lanes link connect memory` already wrote — the whole
  namespace, writes included — so nothing is newly expressible. Read it together with ADR-003:
  default deny exists so that nothing reaches an *account* before its owner says so, and no
  provider in this list has one. The per-item vault rule from ADR-012 §3 is untouched, and is
  worth checking against the text if the phrase "granted by default" makes you uneasy.

- **ADR-053** amends ADR-018 without disturbing it. That decision's argument — a deployed
  instance has no door a browser can come through — is why the dashboard was local-only, and it
  is untouched. What changed is that the local-only page was the only surface a person could
  read, and the desktop app now reads the same facts through this CLI rather than through the
  endpoint, so the constraint no longer costs anyone the surface. Read it for the break as much
  as the deletion: `lanes link dashboard` refuses `--profile` and `--target` now, which is
  ADR-037's rule applied to a command that stopped having anything to select.

- **ADR-051** follows from ADR-012 rather than amending it: the discriminator it uses to justify
  two more providers is the one ADR-012 established, applied to a property that decision did not
  have to consider. Two things in it are not really about tasks or assets at all — the rename of
  Google Tasks to `google_tasks`, which the reserved-id check forces, and the redaction keys that
  had to lengthen with it. Both are recorded there because a redaction key that misses withholds
  every argument and reads exactly like working redaction, which is not a thing to rediscover.

- **ADR-057 and ADR-058 are one change in two halves**, and reading either alone misleads. The
  first moves a connection out of the profile and into the workspace; the second moves the
  granularity that move destroys back into the rule. Taken together they retire ADR-003's central
  trade — "a narrower grant is a narrower profile" — which was sound only while a second profile
  was the only way to hold a second set of rules over one account.

  What survives is every invariant anyone relies on: default deny, deny-wins, tighten-only, and
  one implementation shared by discovery and enforcement. What is given up is stated in ADR-057
  under its own heading, and the load-bearing sentence is that a workspace is now the only
  isolation boundary — `rm -r data/work` stopped being the whole answer to "what could work
  reach", and `profile remove` prints what outlives it because of that.

- **ADR-059** is what keeps ADR-030 true after ADR-057 moved everything else out of the profile.
  Read the two together or the second reads as a retreat. ADR-030 argued that a procedure is as
  private as the knowledge it operates on, and that argument is untouched — what changes is that
  privacy is now expressed by which instance a profile is granted rather than by a file path the
  owner had no say in. The sentence to carry away is that ADR-009's "profiles share nothing"
  becomes a default rather than a guarantee, and the shipped default shares.

- **ADR-060 fills the slot ADR-003 kept empty on purpose.** That decision passed one principal
  everywhere and said, in as many words, that carrying it explicitly was what would make delegated
  access additive rather than a rewrite. This is the addition, and the seam held — it is new rows
  and one check ahead of policy, not a new signature on the dispatch path.

  It also closes most of what ADR-009 admitted was open. Not all: `kind: 'machine'` still reaches
  every profile behind one string, because a headless runner has no browser. The gap moved from
  every registration to one credential, which is a narrowing rather than a fix, and ADR-009 stays
  the place it is described.

- **ADR-061 finishes ADR-052 and reopens a piece of ADR-037.** The first half is bookkeeping: that
  decision made a workspace *be* a target and left two words for it. The second half is not, and
  should be read as the trade it is. ADR-037's objection was to "the dotfile nothing prints", and
  the answer here is a default that prints itself on every command and is refused outright by every
  command that publishes or destroys. If the echo is ever dropped for tidiness, the decision has
  been reversed.

- **ADR-062 and ADR-063 both take something back from a decision that was right when it was made.**
  ADR-062 replaced the consent form's pasted token, which ADR-018 shipped and ADR-039 named as the
  most valuable thing on a loopback bind — so the endpoint gets safer and gains a dependency in the
  same change. ADR-063 grants one browser origin a read of a loopback endpoint, which ADR-039
  refuses in a paragraph written to be read by whoever tried this. It is closed on a separate
  listener, with a separate credential, on a surface with no mutation, rather than by relaxing the
  rule.

- **ADR-064 amends ADR-063, and the amendment is a lesson in reading one's own refusal.** ADR-063
  declined to pair a deployed endpoint, and every clause of the reason it gave was about the
  *certificate* — installing one for an address the machine does not answer on. That was correct
  and is still correct; a deployed endpoint needs no certificate because the platform terminates
  TLS. What the argument never established is that the *credential* and the *address* should be
  withheld, and withholding them left half the people running this unable to see their own
  workspace. The four properties that were not about TLS are kept, one of them tightened: the
  deployed bind names its origin rather than taking the wildcard `cors.ts` would have allowed it,
  because the wildcard's justification is the absence of a setup step and there is no setup step
  here to avoid. Read the 403-versus-404 paragraph if nothing else — the whole of the boot failure
  ADR-063 recorded turns on which of the two Secret Manager returns, and one IAM binding is what
  moves it from the first to the second.

- **ADR-056** follows from ADR-042 and amends ADR-041. The first is the interesting relationship:
  it applies identity's argument to everybody who is not the owner, and then diverges from it
  twice on purpose — `entities` is agent-writable and granted by default, where `identity` is
  neither. Both differences turn on the same test, and it is not "is it empty": memory arrives
  empty and is granted. It is *can it be filled in from here*, which configuration cannot be
  (ADR-007) and an owner's own store can. The amendment to ADR-041 is smaller than its title makes
  it look — that exclusion was a discriminator rather than a count, and the structural part, the
  absence of any field that could name the credential store or the vault, is untouched.

  Read the ambiguity rule if nothing else. An earlier draft refused on more than one match; this
  one returns them all and errors on nothing, because an assistant handed two people called Jan
  asks which is meant rather than failing. What replaces the refusal is three rules — ordering is
  not selection, the count comes first, and several matches render only what tells them apart —
  and they are load-bearing in a way a refusal was not: with no error, they are the only thing
  between two candidates and a message sent to the wrong person.

- **ADR-065** amends ADR-034 from outside this repository, which is the unusual part: no code here
  changes, and the decision is implemented in the desktop app. It is recorded here because the
  sentence it makes untrue is here — ADR-034's *nothing updates itself, and nothing blocks on
  asking* — and a reader who found only the app's side of it would reasonably conclude the rule had
  been forgotten rather than revisited. The install shape is untouched: same command, same Bun-only
  constraint, same refusal to touch a checkout.

  The part worth carrying away is the cwd. `update` migrates and repairs the workspace the walk
  from the cwd finds, so any caller that is not a person in a terminal has to say where it is
  standing. The app names home. Anything else driving this CLI should assume the same obligation
  rather than inherit whatever directory it was launched from.

- **ADR-066** reverses the half of ADR-059 that moved the owner layer's bytes beside the
  connection. The argument for it was sound and the default undid it: the templates create every
  profile granting the same instances, so a `work` profile made to keep work separate read
  `personal`'s notes and nothing said so. The profile goes back in front of the bytes and the
  instance stays behind it, so the shipped default is isolation and someone who wants two
  memories in one profile still has them.

  Worth reading for what it costs rather than what it restores. Cross-profile sharing is gone with
  no replacement, and two profiles that were sharing one instance become two copies at the
  migration — copied into each and the original left, because merging two sets of notes is not
  reversible and picking one would take the other's away in silence.

- **ADR-067** is the layout that follows: a profile is one directory holding its declaration and
  everything it owns, `data/` goes, and `lanes-link.yaml` becomes `workspaces.yaml`. It also
  renumbers every connection id to `lan<n>` and `con<n>`.

  The part to read is why the id stopped describing its account. `idFromAccount` took the local
  part, so the same name at two domains gave `ada_lovelace` and `ada_lovelace2` — and the id is
  the whole of the `connection` enum a model chooses from. An id that half describes its account
  is worse than one that does not. Note also that dropping `data/` does not remove the IAM
  exclusion it existed for; it moves it, and turns a denylist into an allowlist.

- **ADR-068** finishes what ADR-060 started. A credential names a person, and what it reaches
  follows from the member lists — for the static `llk_` token as well as for an OAuth one. The
  endpoint token moves from `auth.token_ref` on every profile to `tokens:` on the workspace, which
  is contract 5.

  The part to read is why every endpoint command was asking for a profile. Not because the
  endpoint is per-profile — one serves every profile in the workspace — but because the token's
  ref defaulted to the constant `profile/token`, so finding it meant resolving one. The same
  constant is why removing a profile once deleted the token its siblings were served by, and the
  fix is not the survivor check that was added then: the token was never a profile's to declare.

- **ADR-069** narrows ADR-063 rather than reversing it. The pairing token reads and writes the
  owner's own data — memory, tasks, assets, skills and entities — and still cannot reach a
  connection, a profile, a grant, a token, the configuration, the audit log, or a vault value.

  The part to read is the sentence being narrowed. ADR-063 said "reads only, ever" and argued it
  from *editing a connection or a profile*, which is configuration and which ADR-007 excludes
  because it authorises future agent behaviour. Writing a memory entry authorises nothing, the
  owner layer arrives granted for that reason (ADR-050), and every connected agent already writes
  these five stores. What genuinely changes is that a credential which could read every memory
  entry can now delete them, including one minted before this release, which is why the cost is
  named in the CLI's own prompt rather than only here.

- **ADR-070** is the one to read before the other two. Everything Lanes Cloud is rests on one
  process serving many workspaces, and the honest way to state that is not "multi-tenancy was
  added" but "the boundary that used to be a process is now a code path". The record says what
  holds it up — a router above the generations, a credential namespace, a vault key source — and
  says plainly that a bug in any of the three is a cross-tenant leak, which is a severity this
  repository has not had to reason about before. `container.ts` is untouched: a self-hosted deploy
  runs what it ran.

- **ADR-071** is why a third root exists at all. A `gs://` root is opened with the caller's own
  Google credentials, which is right for a bucket the operator owns and impossible for one of
  ours. The better reason is the second one: "may this person read this workspace" already has an
  answer, on the API, and asking it again inside a storage adapter would be a second place to
  decide one thing. The cost named in it is real — Lanes is now in the path of a managed
  workspace's configuration, and a credential written from a laptop cannot be read back.

- **ADR-072** exists because the API's own staging mechanism is a trap, and this is the record of
  choosing not to copy it. Overriding each secret individually means a forgotten one leaves staging
  reading production, silently; two already are. Deriving everything from one name and refusing to
  boot on a mismatch trades a container that will not start for a staging revision that reads
  somebody's mail, which is not a close call.

- **ADR-073** changes a sentence ADR-007 ends on, and is worth reading for the error it corrects as
  much as for the decision. The managed design had a second service, IAM-locked, so that the
  endpoint could go on never mutating its own configuration. The reasoning under it — that a managed
  endpoint must be publicly reachable, because no MCP client can mint the identity token Cloud Run
  IAM wants — is true in every clause and does not reach its conclusion: it holds only if a client
  connects *to the endpoint*, which was an assumption. With `api.lanes.sh` as the only front door
  the runtime is private, IAM is the outer gate, and the control routes have somewhere safe to live
  inside it.

  What ADR-007 protects is untouched: an agent holds a token this endpoint issued and the control
  routes take an assertion Lanes signed, so an agent still cannot widen its own access. What
  changes is that a *managed* revision writes its own configuration where a self-hosted one still
  cannot, and the record says which costs come with that — including an IAM condition that has to
  widen for the managed service account alone.
