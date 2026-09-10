# Testing the search by hand

Two commands. Neither needs a workspace, a credential, or a network — both run the real ranking
and rendering over a fixture corpus of eleven providers and 51 capabilities.

## Is the ranking still good?

```console
$ bun run bench:retrieval
```

```
  retrieval over 51 capabilities, 16 questions
  ──────────────────────────────────────────────────────────
  answer ranks first           94%  (was 31%, +63)
  answer in the first three   100%  (was 63%, +37)
  answer carries a schema     100%  (was 81%, +19)
  mean answer size           1393 B  (was 4063 B, -2670)
  ──────────────────────────────────────────────────────────
```

The floors are asserted, so a change that makes ranking worse fails. The percentages are printed
rather than only checked, because a slide from 100% to 91% passes a 90% floor and is still a
regression.

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
