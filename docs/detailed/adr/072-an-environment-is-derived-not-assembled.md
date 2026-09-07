# ADR-072: A deployment derives its environment, and a mismatch refuses to boot

**Status:** accepted · **Follows from** [ADR-070](070-one-process-serves-many-workspaces.md),
[ADR-071](071-a-managed-workspace-is-a-workspace.md)

## Context

A Lanes-hosted runtime has two deployments, staging and production, sharing a code path, a
container image and a cloud project. The Lanes API already has that shape, and the way it derives
staging is the thing this record exists to not copy.

Its stage trigger overrides **each secret substitution individually** to a `_STAGING` twin. A
secret added to `cloudbuild.yaml` without a matching override therefore leaves staging reading the
production secret. Nothing warns. Two are already in that state, and have been for months.

For a form endpoint that misroutes a submission, which is bad. Here the secrets are OAuth refresh
tokens for customers' mailboxes, and a staging revision reading production storage is not a
misrouted record — it is an unauthorised read of somebody's mail by a deployment nobody thought was
pointed there. The mechanism has to fail the other way.

## Decision

**One environment name, everything derived from it, and a mismatch is a boot failure.**

`_ENV_NAME` is the only substitution a stage trigger overrides. The storage root, the secret
prefix, the API URL and the endpoint domain are computed from it. One thing to get wrong instead of
fifteen.

`environmentFrom` has **no default**. An unset or misspelled variable resolving to `prod` is
exactly how a staging revision comes to hold production's root, so an unrecognised value is a boot
failure rather than an assumption. `staging` is refused beside nonsense for the same reason: one
spelling, or the check below has two things to agree with.

`assertEnvironmentMatches` is called once per derived location and **throws**. Refusing to start is
the part worth arguing with, so it is stated rather than implied: a mismatch that logs a warning
and serves anyway is the silent fallback with an extra step, and what it would be protecting is the
one asset in this system that cannot be un-leaked.

## Why one substring rather than a rule per location

A bucket, a hostname and a secret prefix are spelled differently enough that any single pattern
fitting all three would be loose — and a loose rule here is worse than no rule, because it passes
the case it exists to catch while looking like protection.

So the check is one marker. A production name that happens to contain it fails closed and is
renamed, which is the right way round: the cost of the false positive is a rename before anything
ships, and the cost of the false negative is a mailbox.

## What this costs, stated plainly

**A deployment can refuse to start over a naming mistake**, and a container that will not boot is a
worse *symptom* than one that boots wrong. It is a much better *outcome*, and the message names the
location, the value and both sides so the fix is visible in a log with no command line to inspect.

**Neither environment can be reached from the other, including deliberately.** Copying a production
workspace into staging to reproduce something is not a thing this permits, and that is intended
rather than incidental — it is the same act as the accident it prevents.

## What this does not do

It does not apply to a self-hosted deploy, which has one environment and needs none of this. It
does not make the two deployments independent by itself: separate storage, separate secrets and
separate signing keys are what does that, and this only refuses to run when they have been wired
together by mistake.
