# syntax=docker/dockerfile:1
#
# The deployed target's image. Built from the repository root:
#
#   docker build -f src/deployments/gcp/Dockerfile -t lanes-link .
#
# `lanes link deploy` runs the equivalent through Cloud Build. See
# docs/deployment-cloudrun.md for the whole loop, and for why the config is
# baked in rather than mounted.
#
# There is no build step: Bun runs TypeScript directly, so the image holds
# source, and `bun install` only fetches the third-party dependencies.

FROM oven/bun:1.3.11-slim

WORKDIR /app

# The manifest first, so a source-only change reuses the install layer. One
# package now, rather than fifteen manifests copied ahead of the install to
# satisfy workspace resolution.
COPY package.json bun.lock bunfig.toml ./

RUN bun install --frozen-lockfile

COPY src/ src/

# The workspace is NOT copied in.
#
# It used to be: `COPY lanes-link.yaml` and `COPY profiles/`, on the reasoning
# that the image *is* the config, so a revision fully described what it served
# and rollback was a revision switch. The cost was a rebuild per config change,
# which the comment here called "the tradeoff docs/init.md accepts until it
# becomes annoying".
#
# It became annoying, and it had a second cost that was easier to miss: those
# paths are gitignored, so the image could not be built from a clean checkout
# at all. That is what stopped there ever being one image that serves any
# workspace.
#
# Config now lives wherever LANES_LINK_HOME points — a bucket, for a
# deployment — and `lanes link deploy` uploads it there. See ADR-023 for what
# that gives up and how the guarantee it kept is kept.
#
# What must still NOT arrive here is `data/`: the encrypted credential store
# and its key live there, and the deployed target reads credentials from Secret
# Manager instead. The root `.dockerignore` excludes it, and that exclusion is
# load bearing rather than an optimisation.

# Set at deploy time, not here: a bucket URL is the operator's, not the image's.
# `lanes link deploy` passes it as `LANES_LINK_HOME=gs://<bucket>`. Left unset,
# `resolveWorkspaceRoot` would walk ancestors for `lanes-link.yaml` and fall
# back to `~/.lanes-link`, which in a container is a directory nobody wrote —
# so the endpoint refuses rather than serving an empty workspace.
# Which adapter set to open. The whole point of the milestone is that this is
# the only thing that differs from a local run.
ENV LANES_LINK_TARGET=cloud
# Cloud Run injects its own PORT; this is the default it also uses, so the
# image is runnable unchanged with `docker run -p 8080:8080`.
ENV PORT=8080

# No `data/` directory: the container writes nothing to its own filesystem.
# State, the log, memory, skills and attachments are all objects in the bucket,
# and credentials come from Secret Manager. The image can run read-only.

USER bun
EXPOSE 8080

# Not `lanes link start`: that command is a terminal UI that mints a token when
# none exists. See the note at the top of src/server/container.ts.
CMD ["bun", "run", "src/server/container.ts"]
