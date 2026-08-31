# ADR-063: One origin may read a loopback endpoint, over a certificate it installs

**Status:** proposed — there is no read listener and no `lanes link pair`; nothing described here is built · **Narrows** [ADR-039](039-cross-origin-access-is-a-deployment-only-grant.md) ·
**Reopens for a different audience** [ADR-053](053-the-page-a-person-reads-is-the-app.md) ·
**Constrained by** the loopback guard in `src/server/rebinding.ts`

## Context

The audience for a page about this endpoint has now moved twice. It was a page the endpoint served
at `/dashboard`; ADR-053 retired that and sent people to the Lanes desktop app, which shells out to
the CLI and therefore works whether the endpoint is local or deployed. It is moving again, to the
Lanes web dashboard, for reasons outside this repository — one place for connections, profiles and
the audit log, on any machine, beside the rest of the product.

The difference that matters is that the desktop app is *on the machine* and a web page is not.
`lanes.sh` reaching a local endpoint is a cross-origin request to `127.0.0.1`, and ADR-039 refuses
that deliberately and says so in terms that anticipate this decision:

> A reader who later notices that `lanes link start` cannot be given an allowed origin should read
> this paragraph rather than close the gap.

The paragraph's argument is sound and is not being discarded. A deployment's wildcard grant is safe
because the endpoint is *already publicly reachable* — "the wildcard grants a browser exactly what
`curl` already has". None of that holds on loopback, where a hostile page reaching `127.0.0.1` is
stealing something no attacker otherwise has: reachability.

So the gap is closed, but not by relaxing the rule that protects it.

## Decision

**A second listener, for reading, on its own port, over TLS.**

```
http://127.0.0.1:7337/mcp          the endpoint. Unchanged. No CORS. No new route.
https://127.0.0.1:7338/state       connections, profiles, health
https://127.0.0.1:7338/audit       the log, most recent first
```

Five constraints, and each of them answers a specific sentence in ADR-039:

- **One origin, named, never `*`.** `https://lanes.sh` and nothing else, echoed rather than
  wildcarded, with `Vary: Origin`. A deployment's default may be a wildcard because it is already
  public; this is not, so it is not.
- **A different credential, which cannot call a tool.** A pairing token minted by
  `lanes link pair`, stored under its own ref, rotatable and revocable on its own. It is not the
  MCP bearer and it is not an OAuth token, and the surface it opens has no mutation on it at all.
  ADR-039's "an origin is not a permission" is the same point from the other side.
- **The credential is still never ambient.** No cookie, no session — an `Authorization` header the
  page must already possess, obtained by the owner running a command and pasting a link.
- **Reads only, ever.** Editing a connection or a profile from a browser would put control-plane
  mutation behind a CORS grant, and ADR-007 is not moving for a convenience.
- **The MCP listener is untouched.** No CORS on it, no new route, no change to the rebinding guard
  for `/mcp`. Everything ADR-039 protects on the endpoint stays protected, because the endpoint is
  not what answers the dashboard.

**TLS, because of Safari.** Chrome, Edge and Firefox treat `127.0.0.1` as a potentially trustworthy
origin and let an HTTPS page fetch it. Safari does not, and there is no header, flag or opt-in that
changes that — an `http://` read surface simply does not exist for a Safari user. So the read
listener terminates TLS with a locally trusted certificate. This is the whole reason for a second
port: the MCP listener must keep answering `http://127.0.0.1:7337` for every registration that
already exists.

**`lanes link pair` provisions it, and asks first.** It prefers **mkcert**, which is the one tool
that installs into the system trust store *and* Firefox's separate NSS store across macOS, Linux
and Windows; where it is absent the command offers `brew install mkcert` and stops if declined.
This is ADR-053's precedent applied unchanged — installing something on the machine is the largest
side effect a command here has and the one a person is most entitled to decline — and a run with
nobody at the terminal is refused rather than assumed.

**The pairing token travels in a fragment.** `lanes link pair` prints
`https://lanes.sh/dashboard/link#pair=<token>`. A fragment is not sent to the server, so the
credential does not reach a Lanes access log, a proxy, or a referrer header on the way to a page
whose entire purpose is that Lanes does not see this data.

## What this costs, stated plainly

**A certificate in the machine's trust store.** That is a real, persistent change to the machine,
made by a CLI, and it is worth naming as the largest thing in this decision. mkcert's local CA is
the same one it installs for any other project, its private key sits in the user's own directory,
and anyone who does not want it has `lanes link pair --print` and the deployed endpoint instead.

**A certificate expires.** `status` reports the expiry and `pair` renews. An expired certificate
fails in the browser with an error the page cannot read, which is the failure mode ADR-036 reversed
elsewhere, so the dashboard shows the `lanes link pair` command whenever the local read fails for
any reason rather than only when it is unpaired.

**A second port, and a second thing that can be occupied.** `outputs` already reports when
something else holds the MCP port, for the reason that calling it "running" would point someone at
another workspace's accounts; the read port gets the same treatment.

**A pairing token is a read of everything.** It lists every connection, every profile and the whole
audit log for the workspace. It does not call a tool and it cannot change anything — but "read
only" is not "harmless", and the log in particular is a record of what the owner's agents have
done. It rotates with one command and the page is told to re-pair when it is refused.

## What this does not do

It does not add CORS to `/mcp`, on loopback or anywhere. It does not make the endpoint itself
browser-reachable — ADR-039's closing line stands, and this is a different surface rather than a
relaxation of that one. It does not let the dashboard change anything: every mutation is still a
command the owner runs, which is what ADR-053 gave up the served page's copyable line for and what
ADR-007 has required since M1. And it does not send anything to Lanes: the page runs in the
owner's browser, the fetch goes to their own machine, and no local state transits a Lanes server.
