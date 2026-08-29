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

# Pinned by digest, with the tag kept beside it so the next bump is legible.
#
# A tag is a pointer its publisher can move. `1.3.11-slim` is not a promise about
# bytes — it resolves to whatever was last pushed under that name — so a rebuild
# months from now can ship a base image nobody here reviewed, in a container that
# holds live OAuth refresh tokens. The digest is the bytes.
#
# `bunfig.toml` already makes this argument about npm packages, with a seven-day
# release-age floor; the base image is the larger half of the same supply chain
# and had nothing.
#
# To bump: change the tag, then resolve it —
#   docker buildx imagetools inspect oven/bun:<tag> --format '{{.Manifest.Digest}}'
# The digest below is the multi-arch index, so it still resolves per architecture.
FROM oven/bun:1.3.11-slim@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9

WORKDIR /app

# The manifest first, so a source-only change reuses the install layer. One
# package now, rather than fifteen manifests copied ahead of the install to
# satisfy workspace resolution.
#
# `bun.lock*`, not `bun.lock`, and the star is the whole point: **npm strips a
# root lockfile out of a published tarball whatever `files` says.** Verified
# against npm 12, which is what `release.yml` installs before publishing; npm
# 11.6 still packs it, so a local `npm pack` says the opposite and the gap only
# shows up in what people actually install.
#
# This image is built from whichever tree `lanes link deploy` is run against, and
# there are two of them. From a checkout the lockfile is present and pins the
# whole transitive set. From a bun-global install — the only install method this
# CLI documents — it cannot be there at all, and naming it outright made deploy
# impossible for every one of those users: the build pulled the base image,
# pushed a context, and then died on `stat bun.lock: file does not exist`.
COPY package.json bunfig.toml bun.lock* ./

# Not `--frozen-lockfile || bun install`: that swallows a genuine
# lockfile-versus-manifest disagreement in a checkout build, which is the one
# thing the frozen flag is for. The branch says which tree it is building and
# holds the guarantee that tree can offer.
#
# What the fallback gives up is narrower than it looks. Every runtime dependency
# in `package.json` is an exact version, so the direct set is identical either
# way; the lockfile pins what those depend on in turn, and a published package
# has never been able to carry one.
#
# The fallback says so out loud. An unfrozen resolve is a real difference in what
# ships and it used to be silent — the build log looked identical either way, so
# "which transitive versions did this image get" was answerable only by opening
# the image. One line makes it answerable from the build.
RUN if [ -f bun.lock ]; then \
      bun install --frozen-lockfile; \
    else \
      echo "no bun.lock in the build context: resolving transitive dependencies fresh." >&2; \
      echo "Direct dependencies are exact in package.json, so the direct set is unchanged." >&2; \
      bun install; \
    fi

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
