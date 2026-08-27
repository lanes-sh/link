# ADR-052: A target owns its workspace, and a profile lives in exactly one

**Status:** accepted · **Supersedes** [ADR-044](044-a-deployment-records-where-it-lives.md) ·
**Amends** [ADR-043](043-a-target-scoped-command-acts-on-the-target.md) ·
**Follows from** [ADR-023](023-the-workspace-is-not-in-the-image.md),
[ADR-009](009-one-endpoint-per-workspace.md)

## Context

ADR-023 moved the workspace out of the image and into a bucket. From the first deploy onward
there are two copies of every profile: the one in `~/.lanes-link/profiles/personal.yaml` and
the one in `gs://bucket/profiles/personal.yaml`. They are meant to agree.

ADR-044 responded to them not agreeing, by adding an index recording where a deployment lives,
and `sync targets` to reconcile the two copies. Its own context section describes the incident:
a profile rewritten by hand or by a tool lost its cloud target, `auth.authorization` and four
connections, while the bucket still held every one of them and the service went on answering.

It happened again, in the same shape, while this decision was being written:

```console
$ lanes link status --profile personal --target cloud
personal  cloud declared  7 connection(s)
```

```console
$ LANES_LINK_HOME=gs://personal-lanes lanes link profile list
gs://personal-lanes  personal   # 15 connections: gmail ×2, drive, calendar, sheets,
                                # tasks, contacts, slack, icloud ×3, bunq, memory, skills
```

The local file had been rewritten eight hours earlier and had lost eight connections and its
whole cloud target. The endpoint was serving all fifteen throughout. The settings page, which
reads the local file for every target, reported the loss as though the deployment had it.

Both previous responses treated the disagreement. Neither treated the reason there are two
things that can disagree, which is that **a profile declared the targets it could run on**:

```yaml
# profiles/personal.yaml, contract 1
targets:
  local:
    credentials: { adapter: file, path: ./data/personal/credentials.enc }
    storage: { adapter: filesystem, path: ./data/personal }
  cloud:
    credentials: { adapter: gcp-secret-manager, project: personal-lanes }
    storage: { adapter: gcs, bucket: personal-lanes }
    deploy: { platform: cloudrun, region: europe-west1, service: lanes-link-personal-mcp }
```

Because the block was inside the profile, deploying copied the profile to the bucket, and the
copy carried its own claim about where it ran. Two files, each authoritative about the same
target, each editable independently. Every mechanism built on top — the index, the merge, the
`--prefer` flag that picks a winner — is machinery for choosing between two answers to a
question that should have had one.

ADR-044 saw this and drew the line one step short. It insisted its index was "an index, not
configuration", because "a target is still declared by the profile" and resolving from a second
place would be a second source of truth. That reasoning is right and its conclusion was the
wrong half: the fix was not to keep the index inert, it was to stop the profile declaring
anything.

## Decision

**A workspace *is* a target.** It declares its adapters once, in its own `lanes-link.yaml`, and
holds the profiles that live in it. A profile declares no target at all and is therefore one
copy, in one place.

```yaml
# ~/.lanes-link/lanes-link.yaml — this machine, and what it can reach
contract: 2
targets:
  local:
    credentials: { adapter: file }
    storage: { adapter: filesystem }
  cloud:
    workspace: gs://personal-lanes      # a pointer, and nothing else
```

```yaml
# gs://personal-lanes/lanes-link.yaml — authoritative for itself
contract: 2
targets:
  cloud:
    credentials: { adapter: gcp-secret-manager, project: personal-lanes }
    storage: { adapter: gcs, bucket: personal-lanes }
    deploy: { platform: cloudrun, region: europe-west1, service: lanes-link-personal-mcp }
```

A registry entry is either a **declaration** or a **pointer**, and the schema refuses one trying
to be both. Following a pointer is a read of that workspace's own file — so `--target cloud`
needs the bucket reachable, and a target that cannot be read says so.

**This is not the inference ADR-037 removed.** That was a resolution *chain* — a flag, then an
environment variable, then a key in a file — where the operator could not see which of three
sources had answered. This is one declaration, in one file, with no fallback: a pointer is
followed to exactly one place, and a workspace that does not declare the target refuses rather
than guessing. ADR-044 was right that a *second* source of truth is the failure; the pointer is
not a second one, it is the only one.

**Selection reverses.** A target is now resolvable before any profile is read, and it has to be:
`personal` on `local` and `personal` on `cloud` are two files in two workspaces, and only the
target says which one a command means. So commands ask for the target first, and `profile list`,
`profile add` and `profile remove` gain a `--target` they did not need while every profile was
in the same directory.

**Contract 2, and contract 1 is not read.** A binary that loaded either shape would be this
same problem one level up: two spellings of "where does this target live", both valid,
disagreeing silently. `profile/legacy.ts` understands contract 1 and only the migration uses it.

## Consequences

Several things stop existing, and that is most of the value:

- **`sync targets` loses its merge.** `sync-apply.ts`, the diff engine, and `--prefer local|remote`
  all existed to reconcile two copies. What survives is adoption: `--discover` and `--from` find
  a deployment the registry has no pointer to and write one. Adoption cannot lose anything,
  because the bucket is authoritative for everything except its own address.
- **The deploy pre-flight goes.** `servable.ts` refused a deploy carrying a profile that did not
  declare the target, because the endpoint opens every profile in the bucket against one target
  and one that could not run there took the revision down. No profile declares a target now, so
  the state is unreachable.
- **`profile add` stops prompting.** It had to give a new profile an adapter block per target,
  and for anything but `local` there was nothing safe to derive one from — so it copied a
  sibling's or asked. It writes the file into the target's workspace instead.
- **`knowledge:` moves onto the profile.** It says where *this profile's* memory and skills live,
  and was per-target only because a profile could be declared against several. A profile is in
  exactly one now, so per-profile and per-profile-per-target are the same thing, and the former
  is what ADR-030 says a profile owns.

What it costs:

- **A cloud target is a network read.** Listing or reading its profiles needs the bucket and
  working credentials. Offline, `--target cloud` reports unreachable where it used to answer
  instantly from the local copy. That is the trade taken deliberately: the instant answer was
  wrong for eight hours and presented as current.
- **A profile name is scoped to a target.** Local `personal` and cloud `personal` are two
  profiles that share a name. For the workspace above that is not a migration artefact to clean
  up — it is an accurate description of two files that had already diverged.
- **Migrating a bucket breaks the revision in front of it** until a new image rolls, because
  contract 1 is not read. `deploy` therefore migrates the target workspace itself, between the
  upload and the rollout, which keeps that window to seconds. `update` migrates the local
  workspace and deliberately leaves remote ones alone.
