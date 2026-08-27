# ADR-049: A profile's manifests are read through its store, not through the filesystem

**Status:** accepted · **Amends** [ADR-030](030-a-profile-owns-its-skills-and-manifests.md) ·
**Follows from** [ADR-014](014-owner-layer-is-managed.md) ·
**Relates to** [ADR-008](008-connectors.md)

## Context

A custom provider did not exist on a deployed endpoint. Not "worked partially", not "needed a
step" — the manifest was uploaded, the read grant covered it, and the loader never looked.

`loadProfileProviders` read the directory with `node:fs`:

```ts
const directory = join(workspaceRoot, layout.providers(profile));
entries = await readdir(directory);
```

A deployed revision is handed `LANES_LINK_HOME=gs://<bucket>` at rollout, and
`resolveWorkspaceRoot` returns it unmodified because that is exactly what it is for.
`path.join('gs://bucket', 'data/personal/providers.d')` is `gs:/bucket/data/personal/providers.d` —
one slash, a relative path, nothing there. `readdir` threw `ENOENT`, and the catch beside it
reported the empty list it reports for a workspace that has no manifests:

```ts
} catch {
  return []; // No custom providers is the normal case.
}
```

That comment is true and it is why nothing was ever reported. Every other part of the path worked:
`upload.ts` carries `providers.d/` to the bucket because `authoredAreaOwner` matches the directory
segment; `deployment-cloudrun.md` documents the `objectViewer` grant over "each `providers.d/`";
`grants.test.ts` evaluates the shipped IAM expression to prove the write exclusion. A file arrived,
was granted, and was not read.

ADR-014 had already met this exact problem and answered it, for skills:

> a path is baked into a container image at build time and an object key is not

Skills are read through a `BlobStore`. Manifests were not, and the divergence was invisible because
the failure mode of a filesystem read against a bucket URL is silence.

## Decision

**`loadProfileProviders` reads through `workspaceFiles(root)` — the same `BlobStore` seam every
other workspace-owned document goes through.**

`workspaceFiles` already returns a filesystem store for a path and a GCS store for
`gs://<bucket>[/prefix]`, and `#providers` may already import `#profile`. So the change is a `list`
and a `get` where a `readdir` and a `readFile` were, and a manifest is addressed by *key* either
way. Everything else about the loader holds: the `.yaml`/`.yml` filter, the `*.example.yaml` skip,
the sort, and the missing-directory case that really is normal.

Two smaller decisions fall out of it.

**A manifest is a file in that directory, not below it.** Listing a prefix returns everything under
it, and a relative `openapi:` points at a sibling that `upload.ts` carries into the same prefix — so
a key with a `/` left in it after the directory is stripped is a spec, or a folder of them, and not
a declaration. `readdir` gave this for free and `list` does not.

**A relative `openapi:` is refused on a bucket workspace rather than resolved into nothing.** The
generator wants a filesystem path or a URL, and there is no third thing a bucket key can become.
Resolving it with `path.resolve` produced a path that does not exist, which surfaces as a discovery
failure the runtime swallows so that startup survives an unreachable provider — leaving a provider
registered with zero capabilities and nothing anywhere saying why. Refused at load, naming the fix:
publish the spec at a URL.

**Writing stays local.** `connect custom` refuses a `gs://` workspace outright. This is not a
limitation of the loader but ADR-007 holding: a deployed revision never rewrites its own config, so
a declaration is authored where the operator is and carried up by the publish that follows a
connect, or by `deploy`.

## Alternatives considered

**Materialise a bucket-hosted spec to a temp file.** It would make a relative `openapi:` work
everywhere, and it is more machinery than this needs — a cache with a lifetime, an invalidation
question, and a temp directory in a container that may be read-only. A URL already works and is one
line of YAML. Recorded as the follow-up if somebody hits it.

**Bake manifests into the image.** Rejected for the reason ADR-014 rejected it for skills: it would
make declaring a provider a rebuild, which is the whole thing ADR-008 exists to avoid.

**Leave it, and document that custom providers are local-only.** Rejected because the failure is
silent. A deployed endpoint reports healthy and the provider's tools are simply absent, which is
indistinguishable from a policy problem, a discovery problem, or a client problem — and every
existing doc claim to the contrary would have had to be walked back rather than made true.

## Consequences

A manifest written locally serves from a deployed endpoint once it reaches the bucket, which it
already did.

`check` still does not read `providers.d/`, so a malformed manifest is not caught by the one command
whose job is static validation — it surfaces as every *other* command failing for that profile,
because the loader throws for the whole directory on one bad file. `connect custom` validates
before it writes, which closes the path that would create one; a hand-written file still has no
gate. That is worth fixing separately.

`sync targets` also does not carry manifests, despite a docstring and a heading that say it does:
`planBlobs` excludes every `.yaml`, which was almost certainly meant to keep `profiles/*.yaml` out
of the byte-comparison path and is over-broad. The test that looks like it covers this passes
vacuously, asserting no changes for two identical files — which is also what the exclusion
produces. Left alone here because the intent is not clear from the code, and guessing at it would
change what a recovery command copies.
