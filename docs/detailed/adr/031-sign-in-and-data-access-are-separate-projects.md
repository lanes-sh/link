# ADR-031: Signing in and reaching Google data are separate Cloud projects

**Status:** accepted · **Extends** [ADR-028](028-a-hosted-oauth-client-is-the-default.md)

## Context

Lanes signs people in with Google, and Lanes Link reads their mail with it. Both are OAuth, both
belong to the same company, and there is a standing temptation to register them once. Verification
is annual, a restricted-scope review takes months and puts a third-party security assessment in
question, and doing that twice for one company reads as obvious waste.

So the question gets asked in the honest direction: why not put the client this project depends on
into the project that already signs everyone in, so one approval covers everything Lanes will ever
want to reach — the endpoint today, a direct connector later?

The answer is that Google's unit of verification is the project, which makes the difference
structural rather than a matter of taste.

## Decision

Two projects.

One holds the clients that establish **identity**: the web sign-in and the desktop app's loopback
flow. Between them they request `openid`, `email` and `profile`, and nothing else, ever. That set is
neither sensitive nor restricted, so the project needs no verification, presents no unverified-app
screen, and is subject to no cap. It is also the project every Lanes user passes through to reach
anything at all.

The other holds the clients that reach **Google user data**: the one ADR-028 made this endpoint's
default, and any direct connector added later. It carries the sensitive and restricted scopes, the
verification, and the assessment if one is required.

A capability that needs Google user data gets a client in the second project. It does not get one in
the first, and it does not get a project of its own.

## Why not one project

Four facts about Google's model, each sufficient alone.

**Verification only ever covers sensitive and restricted scopes.** The identity project requests
none, so it needs no approval and can receive none. Merging buys it nothing it does not already
have: the saving it appears to offer is approval for scopes it never asks for.

**The unverified-app cap is per project and permanent.** *"The user cap applies over the entire
lifetime of the project, and it cannot be reset or changed."* Every account that consents before
approval spends a hundredth of an allowance that never refills. Spending it on the project that
holds sign-in would put a non-renewable resource behind the one flow that must never run out.

**A submission is a submission of the whole project.** *"All OAuth Clients within a project
requesting restricted scopes must be ready for verification once submitted. We suggest you delete
or remove OAuth Clients that are not ready for production before submitting a verification
request."* The identity project also holds clients its hosting platform provisions on its own,
which nobody here wrote and nobody here controls. Merging would enter them into a restricted-scope
review to gain nothing.

**One brand per project.** The app name, logo, homepage and privacy link are project-level, so a
merged project shows one consent screen for both purposes. The honest screen for the data client —
naming Gmail and Drive, pointing at a page written to explain why — is not the screen anyone wants
in front of someone who only clicked "sign in".

And one fact about the reverse direction: **a merged project cannot be un-merged.** The cap is spent
for the lifetime of the project, and ADR-028 stamps the minting client on every refresh token, so no
live connection can be moved to a client in another project without being consented again from
scratch.

## Consequences

**The second project is not this endpoint's — it is the one that holds Google data access.** That
distinction costs nothing today and is the whole of the reuse later. A verified project holds many
clients under one brand, so a connector shipped elsewhere in Lanes inherits the approved brand, the
approved scope justifications, and the Letter of Assessment — the part measured in months.

**The brand reads "Lanes Link" anyway, and that is deliberate.** It is what every grant against that
project is today, and <https://lanes.sh/link> is written for the person reviewing it rather than for
someone shopping. A later connector either accepts that name on its consent screen or triggers a
brand re-verification, which is days. What it does not need is a second restricted-scope review or a
second annual assessment.

**A capability wanting a scope nobody has approved yet still needs a submission.** The approved
scopes keep working while it is pending; only requests carrying the new one present the
unverified-app screen and count against the cap. So the reuse is real but partial, and a connector
that stays inside the thirteen already declared costs nothing at all.

**Nothing in this repository can check any of this.** The projects are console state.
`src/providers/google/specs/specs.test.ts` holds the manifests and
[`google-verification.md`](https://lanes.sh/docs/link/google-verification) to the same scope list, which catches a scope
requested but not declared. It cannot catch a scope registered against the wrong project, or a
sensitive scope quietly added to the identity one — and that second one is exactly what would put an
unverified-app screen on sign-in. It is a step on a checklist, performed by a person, and
`google-verification.md` is where the checklist lives.

**An operator who wants none of this still runs `--own-client`.** Their client is their project,
their cap, and their consent screen, and this decision does not reach them.
