# ADR-023: the workspace is not in the image

**Status:** accepted · **Supersedes** the immutable-config note in
`src/deployments/gcp/Dockerfile`, and narrows [ADR-007](007-control-plane-exclusions.md)'s
never-mutates-its-own-config guarantee from "enforced by a read-only image" to "enforced by IAM".

## Decision

`LANES_LINK_HOME` may be a `gs://bucket/prefix` URL as well as a directory. Config is read and
written through a `BlobStore`, and the Dockerfile stops copying `lanes-link.yaml` and `profiles/`.
`lanes link deploy` uploads the workspace to the bucket and passes the URL at rollout.

## Why

The Dockerfile stated the trade and its expiry itself:

> the image **is** the config, so a revision fully describes what it serves and rollback is a
> revision switch. The cost is a rebuild per config change, which is the tradeoff docs/detailed/init.md
> accepts **until it becomes annoying**.

Two things made it annoying. A policy change — the thing an operator most wants to be able to do
in a hurry — was a Docker build, a Cloud Build submission and a new revision. And because those
paths are gitignored, **the image could not be built from a clean checkout at all**, which is what
stopped there ever being one published image that serves any workspace.

The coupling turned out to be small: an `existsSync` ancestor walk that only runs when
`LANES_LINK_HOME` is unset, two reads, one listing, and one write.

## No bootstrap problem

Opening a GCS store needs the URL and whatever identity is already present — on Cloud Run, the
metadata server. And config carries secret *references* rather than values, which
`profile/secret-detection.ts` enforces. So nothing has to be decrypted before the config that says
how to decrypt things can be read, and the boot order gets shorter rather than more circular:
blob store, then config, then credentials.

## What this gives up

**Rollback stops being a revision switch.** A Cloud Run revision no longer fully describes what it
serves, so `update-traffic --to-revisions=PREVIOUS` rolls back the code and not the config. This is
a real loss and it is the reason the original decision was the right one at the time.

What remains: the config is in git on the operator's machine, bucket object versioning covers the
deployed copy, and `lanes link check` validates before any write. For a single-operator gateway
that is the cheaper side of the trade. For a fleet it would not be.

## What it keeps, by moving the enforcement

ADR-007 and `gcp/driver.ts` say a deployed instance never mutates its own configuration. That was
enforced by the image being read-only — a property that does not survive the config moving. It is
now an IAM condition on the one bucket, along the boundary the layout already draws:

- `roles/storage.objectAdmin` on `data/` and `skills/` — skills are writable under policy (ADR-014)
- `roles/storage.objectViewer` on `lanes-link.yaml`, `profiles/`, and `providers/`

[ADR-030](030-a-profile-owns-its-skills-and-manifests.md) moved both of those root directories
into `data/<profile>/`, so the boundary is now drawn inside one prefix rather than between two:
the write grant is `data/` with each profile's `providers.d/` excluded by name, and the read grant
picks the manifests back up. The property this section claims is unchanged — a revision still
cannot rewrite what declares what it is — but the condition carries a negation to keep it, which
is the part worth knowing before editing it.

Conditions on `resource.name` work under the uniform bucket-level access `provision.ts` already
sets. This is stronger than the version it replaces: image immutability protected config only for
as long as config lived in the image.

## Consequences

- **`ConfigDocument.open` takes a workspace root and a profile**, not a path. The two stopped being
  the same string, and `join` on a `gs://` URL silently collapses the `//`.
- **Comment and key-order preservation is unchanged.** The `Document` API still does the editing;
  only the read and the write moved. A test asserts it across the new path, because this is exactly
  the kind of change that loses it quietly.
- **`workspacePath` throws on a remote root.** It exists to resolve filesystem paths for the
  `file` and `filesystem` adapters, which a bucket workspace does not select. Reaching it means a
  target declared a local adapter against a remote workspace, and saying so beats handing
  `gs://…/data/x` to `Bun.file`.
- **The container writes nothing to its own filesystem** and can run read-only.
- **A published image becomes possible**, which would let a deploy skip Cloud Build and Artifact
  Registry entirely. Not done here — publishing, versioning and trust are their own decision — but
  this is the change that unblocks it.


## Note (ADR-052)

Unchanged, and now load-bearing rather than an optimisation.

This decision made a bucket a place a workspace could live.
[ADR-052](052-a-target-owns-its-workspace.md) makes it the place a target's workspace *does*
live, and the only authority on what that target holds — so `isRemoteWorkspace` and
`workspaceFiles` are no longer a deployment convenience, they are how the CLI reads a cloud
target at all.

The guarantee this gave up is unaffected: a revision still does not fully describe what it
serves, and the config it reads is still versioned by the bucket rather than the image. What
ADR-052 adds is that migrating that bucket now has to happen in the same command that rolls the
image, because contract 1 is not read.
