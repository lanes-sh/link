# syntax=docker/dockerfile:1
#
# The Lanes-hosted runtime. Built from a checkout at the repository root:
#
#   docker build -f deployments/managed/Dockerfile -t lanes-link-managed .
#
# **Not `src/deployments/gcp/Dockerfile`**, and the difference is not cosmetic.
# That one is what `lanes link deploy` hands a customer to run their own
# endpoint, and it cannot serve this purpose for two reasons:
#
#   - it runs `src/server/container.ts`, which opens a runtime before it serves
#     anything and needs a profile to open one. A workspace that has just been
#     provisioned has none, so it refused to boot on exactly the workspace whose
#     control surface exists to create its first profile.
#   - it is built from the *installed package*, and `package.json`'s `files`
#     excludes `src/control/**` and the two managed entrypoints. Those are
#     Lanes-only code with no business in every CLI user's node_modules, so the
#     managed image has to come from a checkout. `src/architecture.test.ts`
#     refuses a shipped file that statically imports an excluded one, which is
#     the rule that keeps the exclusion honest.
#
# There is no build step: Bun runs TypeScript directly, so the image holds
# source and `bun install` only fetches third-party dependencies.

# Pinned by digest, with the tag beside it, for the reason the other Dockerfile
# gives at length: a tag is a pointer its publisher can move, and this container
# holds live refresh tokens for other people's accounts.
FROM oven/bun:1.3.11-slim@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9

WORKDIR /app

# The manifest first, so a source-only change reuses the install layer. The
# lockfile is always present here — this image is only ever built from a
# checkout — so the install is frozen with no fallback branch.
COPY package.json bunfig.toml bun.lock ./
RUN bun install --frozen-lockfile

COPY src/ src/

# Cloud Run injects its own PORT; this is the default it also uses, so the image
# is runnable unchanged with `docker run -p 8080:8080`.
ENV PORT=8080

# Nothing else is baked. Every workspace this serves is named by the assertion
# that arrives, so there is no LANES_LINK_HOME and no LANES_LINK_TARGET: a
# managed runtime that carried either would be a runtime pinned to one tenant.
#
# What the deployment must set, and `deployments/managed/cloudbuild.yaml` does:
#   LANES_ENV                  stage or prod. Everything derived is checked
#                              against it and a mismatch refuses to boot
#                              (ADR-072).
#   LANES_API_URL              which API this reads its workspaces through.
#   LANES_CONTROL_PUBLIC_KEY   the API's signing key, so a control call can be
#   LANES_CONTROL_ISSUER       believed, and from whom, and to whom. Pinned
#   LANES_CONTROL_AUDIENCE     rather than discovered.
#   LANES_RUNTIME_PRIVATE_KEY  this runtime's own key, so it may read the bytes
#   LANES_RUNTIME_ISSUER       of the workspace it is serving.
#   LANES_LINK_VAULT_KEY       the master every workspace derives its vault and
#                              credential keys from. One per deployment, never
#                              one per tenant.

# The container writes nothing to its own filesystem: every workspace's bytes go
# through the API, and the keys arrive as environment. It can run read-only.
USER bun
EXPOSE 8080

CMD ["bun", "run", "src/server/managed.ts"]
