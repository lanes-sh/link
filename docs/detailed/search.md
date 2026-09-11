# How Lanes Link finds the right tool

Connect a dozen accounts and your agent is handed hundreds of tools, every one of them described
in full before it reads your first word. This page covers what that costs, what Lanes Link serves
instead, and how well the search that replaces it actually works.

## What a full tool list costs you

Measured on one deployed endpoint with two profiles and eleven providers:

| | tools | on the wire | roughly |
|---|---|---|---|
| `surface: full` | 278 | 702 KB | 180,000 tokens |
| `surface: crunched` | 28 | 31 KB | 8,000 tokens |

180,000 tokens is not a large fraction of a context window. It is most of one, spent before the
agent has read the request. The ceiling is not set here either: most providers are MCP servers
whose schemas are their authors' own, so no amount of care in this repository moves them.

Hosted clients make it worse rather than better. Some cap the aggregate tool list across all
connectors and truncate alphabetically, mid-namespace, with no error.

## Serve a short list instead

A profile can declare how much of what it reaches goes into `tools/list`:

```yaml
surface: crunched
```

Under `crunched` the endpoint advertises the owner layer plus two stable names,
`lanes_tools_search` and `lanes_tools_call`. Everything else stays reachable through the second
of those. No capability is lost. What shrinks is exposition, not authority.

The search returns full JSON Schema for its strongest matches, not just names. That is the whole
design: a search returning only names costs a second round trip and loses the accuracy that
published evaluations attribute to deferred tool loading.

## Measure it yourself

Both commands run the real ranking over a fixture corpus. Neither needs a workspace, a
credential, or a network.

```console
$ bun run bench:retrieval
$ bun run probe "latest email in inbox"
```

For how your own providers rank, ask a running endpoint with `lanes link tools --json`.

## How the ranking works

Term presence, weighted by where the term appears, scaled by how much it narrows the field, then
adjusted for what the question implies. There is no term-frequency component and no document
length normalisation.

**Where a word appears decides what it is worth.** An operation's own name scores 3, its title 2,
its provider 1.5, its description 1, and its argument names 0.5. The vendor's name is scored
apart from the operation's name deliberately: scored together, a provider whose id contains a
domain word wins every query in that domain on spelling alone.

**A word matching everything decides nothing.** Each provider's keywords are appended to every
one of its capabilities identically, so without weighting by rarity every mail tool scored the
same on a mail question and alphabetical order picked the winner. Terms are weighted by inverse
document frequency, floored rather than decayed to zero, because such a word is uninformative
rather than wrong.

**A question about several accounts gets several answers.** Matches are ordered one per provider
before any provider gets a second entry, so two connected mailboxes both appear. Which of them
you meant is not something the endpoint knows, and answering as though one existed is worse than
returning both with their accounts named.

**An answer is budgeted in bytes, not matches.** Three matches is under a kilobyte of one
provider's schemas and 40 KB of another's. The budget is 16 KB, three matches explained by
default and ten at most, and the best match is always rendered in full even if it alone exceeds
the budget.

## What it scores today

Over 139 capabilities across twenty providers, against 36 questions:

| | |
|---|---|
| answer ranks first | 56% |
| answer in the first three | 72% |
| answer carries a schema | 72% |
| mean answer size | 1,841 B |
| ranking 1,000 capabilities | 10.6 ms per query |

These numbers read 94% and 100% earlier in this repository's history, and nothing about the
ranking got worse. The corpus did. It was eleven providers and 51 capabilities against sixteen
questions, where the deployed endpoint above holds 278. Giving providers the depth real APIs
have took top-1 from 94% to 88% on its own; adding a second calendar and a second issue tracker,
then twenty more questions, took it the rest of the way.

The honest floor is the one worth defending, so the old figure is recorded rather than quietly
replaced. `src/server/mcp/ranking.test.ts` names every individual miss, which is the guard that
catches a regression a percentage would hide.

## What it gets wrong

Three failure modes are open and reproducible with `bun run probe`.

**A common verb in an operation's name beats the subject of the question.** An operation called
`findMeetingTimes` takes the first slot on "find a document", because *find* matches its name at
weight 3 while *document* matches a file provider's description at weight 1.

**A provider's identifying word is discounted by its own depth.** Rarity is computed across the
capabilities that matched, so the deeper a provider is, the more the word that identifies it
looks like a word that says nothing. On "add a reminder", *reminder* scored 0.357 against *add*
at 0.540, and every task capability lost to three unrelated operations whose names contain *add*.

**Short words do not reach their own plurals.** A prefix match needs four characters, so "bugs"
does not find "bug" and the query returns nothing at all.

The design goal on record is to be good enough to find the right *provider*, not good enough to
replace a client-side index. Accuracy at provider granularity would be the fairer measure of
that, and it is not measured yet.

## Alternatives weighed

**Vector embeddings.** No vector database is needed at this scale. A few hundred capabilities is
a packed `Float32Array` and a brute-force dot product, well under a millisecond, and vector
stores start earning their keep around six orders of magnitude higher. Storage is a derived,
fingerprinted blob, and `src/providers/entities/catalogue.ts` is a working precedent for one.
The real cost is elsewhere: embedding the query is a network round trip on every search and a new
outbound credential, in a repository that has so far declined every vendor client library. An
embedding also erases what this ranker is best at, including the exact-id short circuit and the
penalty on destructive verbs nobody asked for. The shape would be reciprocal rank fusion across
both rankers with a mandatory lexical fallback, never a replacement. The honest gain is deleting
a hand-maintained synonym table rather than a large jump in accuracy.

**Full BM25.** Adds term frequency and document length normalisation. Presence-only scoring is
already length-insensitive, which is part of why it survives vendor descriptions of wildly
different lengths, and the explicit stopword list here does what a BM25 index does implicitly.
The upside is real and small on text this short. It would not touch any of the three failure
modes above, which are about field weighting and rarity, not about counting.

**Leaving it to the client.** The best clients already defer tool loading and run their own index
locally, with no round trip, and deferred definitions never enter the initial prompt so prompt
caching survives. A stateless endpoint cannot match that last property, because a discovery call
rebuilds the server. This surface is the fallback for clients that do not, which is what bounds
how good it has to be.

## Notes

**Where the decisions are recorded.** ADR-075 for the two stable names and why search returns
schemas, ADR-076 for `surface: crunched` and the measurement above.

**Why a miss can trigger a reload.** Under `crunched`, "nothing reachable matches" is not a hedge
a model retries, it is a claim about your accounts. An endpoint that missed a config change would
be making that claim wrongly, so a miss re-reads the config once before answering, rate limited
to one probe every ten seconds.

**Why the search result carries a read-only hint.** Under `crunched` there is no typed tool to
carry the annotation, so the search result is the only place a client can learn a call is safe to
make. It appears only where the provider classified the operation, never as a negative, because
the absence has to keep meaning "assume not".
