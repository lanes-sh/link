# ADR-044: A deployment records where it lives, and a workspace can be merged with it

**Status:** accepted · **Follows from** [ADR-023](023-the-workspace-is-not-in-the-image.md) ·
**Relates to** [ADR-029](029-connecting-is-not-deploying.md)

## Context

ADR-023 moved the workspace out of the image and into a bucket. A deployed endpoint reads its
config from `gs://<bucket>/profiles/<name>.yaml`, and `deploy` puts it there. From the first
deploy onward there are two copies of every profile.

Nothing compared them, and nothing recorded that the second one existed. The only thing in the
workspace naming a deployment was the target block inside the profile:

```yaml
targets:
  cloud:
    credentials: { adapter: gcp-secret-manager, project: my-project }
    storage: { adapter: gcs, bucket: your-bucket }
    deploy: { platform: cloudrun, region: europe-west1, service: my-service }
```

Six lines, in one file, and they are the sole pointer to a running service, a bucket holding
every byte the endpoint remembers, and a credential store. A profile rewritten by hand or by a
tool takes all of it out of reach in one edit. Nothing had gone anywhere — the service was still
answering — and no command could find it again. `status` reported the target as undeclared,
`deploy` offered to survey a *new* project and bucket, and `outputs` minted a fresh token the
deployed endpoint had never seen.

The bucket, meanwhile, still held the profile exactly as the last deploy left it, including the
target block and four connections the local copy had also lost.

## Decision

Two things, and the second is only possible because of the first.

**An index, in `lanes-link.yaml`, outside any profile.** `deploy` records the target, the
workspace URL, the primary profile and a timestamp, once an upload has succeeded. A record kept
inside the thing it describes cannot survive the thing being lost, which is the whole reason it
is one level up.

It is an index and **not configuration**. A target is still declared by the profile, every
command still resolves from that declaration, and this is read only to know which bucket to
open. An index that starts being resolved from is a second source of truth, which is what
ADR-037 spent a release removing.

**`lanes link sync targets`**, which reconciles the two copies. Where the remote lives is tried
cheapest first: a declared target, then the index, then `--from`, then `--discover`, which asks
the platform and is the only one that works from nothing.

The merge rule is **union, and refusal where a union is impossible**. What one side is missing
is copied to it. What both hold differently stops the run and prints the diff;
`--prefer local|remote` resolves it. Last-writer-wins was the alternative and it is the failure
being fixed — one copy of a profile quietly replacing another that held six connections it did
not.

Two details the diff had to get right:

- **Connections and policy rules compare as keyed sets**, not positionally. Otherwise adding an
  account reads as a change to whichever one now sits at that index. `identity` stays an ordered
  list, because its declaration order is meaningful.
- **The comparison runs over validated configs; the writing comes from the raw document.**
  Validated, so `[gmail.*]` and `[{capability: gmail.*}]` are the same grant rather than a
  conflict. Raw, because writing the validated value back puts every default Zod filled in on
  the way past — `min_instances: 0`, a token lifetime nobody set — into a file the operator
  reads, and expands untouched policy rules into a shape they were not written in.

Sync copies exactly what a deploy uploads, through the same allowlist: the workspace file,
profiles, and the two authored areas inside `data/`. Never the credential store, the state
database, or the log.

## Consequences

The recovery this was written for is one command, and it is not a special case — it is the
ordinary merge, with everything missing on one side:

```console
$ lanes link sync targets --target cloud --discover
personal
  ← targets.cloud             missing locally
  ← auth.authorization        missing locally
  ← connections.gmail.work    missing locally
```

Because the index is written on every deploy, the next such loss does not need `--discover` at
all — the workspace still knows where to look even when no profile does.

Sync is not a backup. It copies config and authored documents, which is the same set ADR-023
made the endpoint read from a bucket; state, the audit log and credentials stay where they are,
and the credential store deliberately never travels.

Two copies that have both changed since they agreed cannot be merged without being told which
wins, and `--prefer` is per run rather than per key. A run with conflicts in two directions has
to be done twice, narrowed with `--profile`. That is the honest cost of refusing to guess, and
it is preferable to the alternative this replaces, which guessed silently.
