# ADR-053: the page a person reads is the desktop app

**Status:** accepted · **Amends** [ADR-018](018-the-gate-is-in-the-application.md) ·
**Follows from** [ADR-037](037-a-command-names-what-it-acts-on.md)

## Context

This endpoint served one surface built for a person rather than an agent: an HTML page at
`/dashboard`, listing connections and their reconciled state, the profiles served, the targets
declared, and — for a provider that was not connected yet — the exact `lanes link connect …`
line to run. It rendered commands; it never ran them.

Reaching it took a command, because a browser navigating to a loopback URL carries no
`Authorization` header. `lanes link dashboard` read the token out of the credential store, put
it in the URL once as `?k=`, and the endpoint exchanged it for a session cookie and redirected
to a URL without it. That machinery — a route above the 404 gate, a cookie exchange, a session
table, a sign-in page for when it failed — existed so that one page could be looked at.

It was local-only, and ADR-018 is why. A deployed instance has no browser-shaped door: Cloud
Run's own gate admits a Google-signed identity token, which a person at a browser cannot mint,
and the alternative is `--access public` with the page behind nothing. Both are worse than not
having one. So the page was the surface a person could read, and half the people running this
could not read it.

What changed is not that argument. It is that the audience found somewhere better to be. The
Lanes desktop app now has a Lanes Link page under Settings → Integrations, and it does not
reimplement any of this — it shells out to this CLI for status, profiles, targets, the endpoint
and client registration. It shows the same facts, it runs the commands the page could only
print, and it works the same whether the endpoint is local or deployed, because it is talking
to the CLI rather than to the endpoint.

## Decision

**Retire the served page.** `/dashboard`, `handleDashboard`, the `?k=` exchange, the session
table, the sign-in page, the page renderer, its shell and the provider-icon table are deleted
rather than left unreachable.

**`lanes link dashboard` opens the app instead**, at
`lanes://settings?page=integrations-link`, and **`lanes link desktop` is the same command under
the name that says what it does.** Both spellings stay: the old one is in a year of notes, the
new one is the one to learn, and unlike the undocumented `skill` alias both appear in `USAGE`
because nobody has learned the new word yet.

**The command drops `--profile` and `--target`.** It was `profile+target` for one reason: it had
to resolve a profile *before* opening a runtime, so that a deployed target was refused before
its adapters reached Secret Manager and a bucket. With nothing to open there is nothing to
order, and `'none'` follows — the precedent is `target list`, which is `'none'` and still takes
a flag of its own.

## Consequences

**A break, named plainly.** `lanes link dashboard --profile personal --target local` now refuses:

```console
error  Unknown flag "--profile" for "lanes link dashboard".
  Accepts: --help --json --print --quiet
```

That is correct and it is blunt — `nearest()` has nothing to suggest, and the message cannot
explain why a flag that worked last week does not now. It is not special-cased. A per-command
exception in `assertKnownFlags` is exactly the corrosion that file exists to prevent, and the
explanation belongs here and in the release notes rather than in the flag checker.

**The security surface shrinks by a class, not by a guard.** `servesDashboard` was two
conditions guarding one outcome: a page listing the owner's accounts, reachable by navigation.
Deleting the route removes the outcome. After this, everything but `/health` and the discovery
documents needs a bearer token, there is no unauthenticated browser-navigable path left, and
`#cli/dashboard-page.ts` stops being a reason for `server` to import `cli`.

**`server/endpoint.ts` came back under the file-size budget on its own.** The exemption in
`architecture.test.ts` named the dashboard route as the seam to cut at rather than cutting by
line count. This is that cut, and the entry is gone.

**One thing is given up, and it is worth naming.** The page rendered the `lanes link connect …`
line for each unconnected provider, spelled with both flags, ready to copy. The app connects
accounts through the CLI rather than printing the command, so the copyable line is gone. If
that turns out to be missed, it belongs on `lanes link status`, which already knows every fact
it needed.

**macOS only, and the command says so.** The app ships for macOS alone; this CLI does not. On
any other platform the command refuses with the platform named and prints the URL it would have
opened. `--print` does the same everywhere, which is what a machine with no desktop wants.

**It installs the app rather than describing how.** A command whose whole job is "open this" and
which answers "it is not installed" has stopped one step short, and the step it stopped short of is
one line. So it offers `brew install --cask lanes-sh/lanes/lanes` and opens the app afterwards.
The symmetry is deliberate: the app installs *this* CLI from its settings page, with a button.

It asks first, and that is not a formality. Everything else this CLI installs is a file in the
workspace it already owns; this puts an application on the machine, which is the largest side
effect any command here has and the one a person is most entitled to decline. `--yes` is for the
run that already decided, and a pipe with nobody at it is refused rather than assumed — the same
three-state split ADR-041 made for `knowledge use`, for the same reason: installing something
because no one was there to say no is the wrong way to resolve an unanswerable prompt.

Homebrew is the mechanism because an install a command performs has to be one an upgrade later
finds. Without brew the command cannot finish, so it hands over both routes and stops.

**A cross-repository contract with no compiler behind it.** `integrations-link` is a page id in
the app's `src/settings/nav.ts`. A test there pins the spelling, and this repository pins it in
`desktop.test.ts`, because the app opens Settings on its current page rather than refusing an id
it does not have — so a rename would degrade silently on both sides. An older app is registered
for `lanes://` too, exits 0, and ignores an action it does not know; the command cannot detect
that and prints the minimum version instead.
