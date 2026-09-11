# Testing the search by hand

Two commands. Neither needs a workspace, a credential, or a network. Both run the real ranking
and rendering over a fixture corpus of twenty providers and 139 capabilities, built to the depth a
deployed endpoint has.

## Is the ranking still good?

```console
$ bun run bench:retrieval
```

```
  retrieval over 139 capabilities, 36 questions
  ──────────────────────────────────────────────────────────
  answer ranks first           56%  (was 31%, +25)
  answer in the first three    72%  (was 63%, +9)
  answer carries a schema      72%  (was 81%, -9)
  mean answer size           1841 B  (was 4063 B, -2222)
  ──────────────────────────────────────────────────────────
```

The floors are asserted, so a change that makes ranking worse fails. The percentages are printed
rather than only checked, because a slide that still clears a floor is still a regression.

These read 94% and 100% against the smaller corpus this fixture replaced, and the ranking did not
change to make them 56% and 72%. [How Lanes Link finds the right tool](detailed/search.md) has the
measurement, the three failure modes behind it, and what was weighed against the current
approach.

## What does it answer to *this* question?

```console
$ bun run probe "latest email in inbox"
$ bun run probe --limit 6 "move a file to a folder"
$ bun run probe --crunched "archive a message"
```

`--limit` is how many get explained in full — three by default, ten at most. `--crunched` shows
what a profile with `surface: crunched` answers, where the capability id leads because there is no
named tool to prefer.

### Reading the answer

```
16 matches for "latest email in inbox".

## mailhub_search_messages          ← the wire name, or the capability id under --crunched
capability: mailhub.search_messages
reachable:  personal: mailhub.acct1  ← which profile and connection to pass
read-only:  yes                      ← only where the provider classified it

arguments (JSON Schema — `profile` and `connection` are added by this endpoint):
...

13 further matches scored lower and are not shown.
```

Two things are worth checking, and both are easiest to see with `--limit 6`:

- **The first few are one per provider.** Two connected mailboxes should both appear before either
  provider gets a second entry. Ranked purely by score the better-worded provider fills every slot
  and the second mailbox never shows up.
- **Every entry carries its full input schema.** A match named without its arguments costs a round
  trip and looks like an answer.

## Against your own accounts

The corpus is a model of a surface, not yours. For how *your* providers rank, ask a running
endpoint:

```console
$ lanes link tools --json
```

To point a scratch endpoint at a throwaway workspace rather than your real one:

```console
$ export LANES_LINK_HOME=/tmp/lanes-link-scratch
$ lanes link start --port 7401
```

Without `LANES_LINK_HOME` the command finds your real workspace — the profiles, credentials and
audit log the deployed endpoint reads.
