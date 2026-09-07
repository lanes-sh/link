# ADR-071: A managed workspace is a workspace, reached over the API

**Status:** accepted · **Extends** [ADR-023](023-the-workspace-is-not-in-the-image.md),
[ADR-049](049-manifests-are-read-through-the-workspace-store.md) ·
**Completes** [ADR-061](061-a-workspace-is-the-only-word.md) ·
**Required by** [ADR-070](070-one-process-serves-many-workspaces.md)

## Context

ADR-023 made `LANES_LINK_HOME` accept `gs://bucket/prefix` as well as a directory, and ADR-049
made every read of configuration go through that store. Between them, a workspace stopped being a
place on a filesystem and became a `BlobStore` with a root — which is what lets one image serve any
workspace.

Lanes Cloud needs a third root, and `gs://` cannot be it.

A bucket root is opened with the caller's own Google credentials. That is exactly right for a
bucket in the operator's project: they own it, they granted the service account, and the adapter
authenticates as whatever identity is already present. It is impossible for a bucket in ours.
Handing a laptop credentials that reach Lanes' storage would reach every tenant's bytes, and
narrowing that per workspace means an IAM condition per tenant on a bucket nobody outside Lanes
should be able to name.

There is a second reason, and it is the better one. The question "may this person read this
workspace" already has an answer, in one place, on the API: it is workspace membership, the same
list a profile's `members:` selects from (ADR-060). Asking it again in a storage adapter would be a
second place to decide the same thing.

## Decision

**`LANES_LINK_HOME` accepts `lanes://<workspace-id>`, served by an adapter over the Lanes API.**

```
~/.lanes-link                 a directory        createFilesystemBlobStore
gs://your-bucket/prefix       a bucket           createGcsBlobStore
lanes://<workspace-id>        Lanes hosts it     createLanesBlobStore
```

It is a `BlobStore` like the other two and it passes the same conformance suite, so the CLI, the
control plane and the runtime administer a managed workspace with the code that administers a local
one. `lanes link profile add work --workspace managed` is not a new command path; it is the command,
against a different root.

`isRemoteWorkspace` covers it, and that is the quiet half of the decision. Every caller of that
predicate is asking whether it may treat the root as a filesystem path, and a managed root
answering "yes" produces a directory literally named `lanes:` beside the process's working
directory — config that reads as *absent* rather than as unreachable, which is the failure ADR-049
was written about.

## The credential is registered, not passed

`workspaceFiles(root)` takes a root and nothing else, at thirty-five call sites, and that is not an
oversight to correct. A credential is a property of the process's identity rather than of any one
call, which is precisely why a `gs://` root needs none either: Google's client resolves Application
Default Credentials from the environment and nobody threads them through.

This adapter cannot do the same thing the same way. Reading the signed-in session means importing
`auth`, and `deployments` may not — the rule that keeps a storage backend from growing an opinion
about who is calling. So the layer that *may* read a session registers one, and the adapter asks
for it at call time rather than at construction, so registration order does not matter. A process
that registered nothing gets a sentence naming `lanes auth login`, not a 401 from three components
away.

A mutable module-level slot is the kind of thing this repository refuses by default, and the
alternative here is threading a credential through thirty-five call sites of a function whose whole
job is "give me this workspace's files".

## Listings are sorted here rather than trusted

The contract every other adapter satisfies says a listing is sorted. A store that is sorted only
when the server felt like it is not the same interface, and the callers that walk a profile's files
would then differ by backend — which is the whole thing `describeBlobStoreContract` exists to
prevent.

## What this costs, stated plainly

**Lanes is in the path of a managed workspace's configuration.** Not its agent traffic — that goes
to the endpoint — but every read and write of a profile, a grant or a connection row crosses a
Lanes server, and an outage there is an outage of administering the workspace. A local or
self-hosted workspace has no such dependency, and this is a real difference between the three
options rather than a detail.

**A credential written from a laptop cannot be read back over HTTP.** The `lanes` secret store
supports `set`, `has`, `list` and `delete`; `get` is refused for a CLI caller and the runtime reads
values internally. That is deliberate and it is a genuine loss of symmetry: `lanes link secrets`
cannot show you a value in a managed workspace the way it can in a local one.

## What this does not do

It does not make the API a control plane for the endpoint — this is storage, and ADR-007's wall is
where it was. It does not change the layout: a managed workspace's bytes are the same tree in the
same shape (`layout.ts`), because a fourth layout for one structure is what that file exists to
prevent. And it does not move a self-hosted workspace anywhere; `gs://` is unchanged and remains
what `lanes link deploy` writes.
