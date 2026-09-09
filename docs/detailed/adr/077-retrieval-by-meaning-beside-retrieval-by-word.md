# ADR-077: Retrieval by meaning sits beside retrieval by word, from a vendored table

**Accepted.** Built in `#server/mcp/vector`, blended in `#server/mcp/ranking.ts`.

## The problem a better lexical ranker cannot reach

`lanes_tools_search` is how anything outside the owner layer is found under
`surface: crunched`, so a wrong first result is not a cosmetic failure — it ends the
attempt before a call is composed.

The failure is vocabulary, not weighting. "latest email in inbox" contains no word that
appears anywhere in `users.messages.list`: the vendor writes *mailbox* and the person
says *inbox*, the vendor writes *task* and the person says *todo*, the vendor writes
*subreddit* and the person says *community*. No re-weighting of terms reaches a term that
is not there.

The lexical answer is a synonym table. It works, and it is bounded by its author's
imagination: every domain needs an entry, every entry is a claim about a vocabulary, and
a table that is only sometimes right is worse than none because it widens what matches.

## The decision

Ship a **static embedding table** and blend a cosine similarity with the existing lexical
score. Neither half decides alone.

**Static, meaning no model runs.** A Model2Vec checkpoint is a sentence transformer's
knowledge distilled into one row per token, so encoding is a vocabulary lookup and a
weighted mean — no layers, no tensor library, no accelerator, no ONNX runtime, and no
download at startup. `minishlab/potion-base-4M` at int8 with a scale per row is 3.9 MB,
vendored by `bun run vendor:vectors` the way the OpenAPI documents are vendored, and read
lazily on the first search rather than at startup.

That property is what makes it deployable here at all. An instance may be created to
serve one request and replaced before the next (ADR-002), so seconds at startup are
seconds on a request somebody is waiting for, and a network call at startup is a way to
fail there.

**Nothing is stored.** Capability vectors are derived from text the endpoint already
holds and are built with the merged catalogue, memoised on it, and collected with it —
40 ms for a thousand capabilities. A persisted index would be a second copy that can
disagree with the first, an invalidation rule, and a migration, bought for nothing.

**Both halves, because each fails where the other works.** A cosine cannot match an
identifier: the nearest neighbours of `users.messages.list` in a semantic space are not
what a caller who typed it wants. Term presence cannot match a synonym. Measured over 166
real operations and 65 questions (`bun run bench:compare`):

| ranking | ranks first | in first three | found at all | MRR |
|---|---|---|---|---|
| words only | 37% | 66% | 83% | 0.527 |
| meaning only | 45% | 69% | 89% | 0.577 |
| **both** | **51%** | **68%** | **92%** | **0.623** |

## Three things this cost, recorded because they are the argument against it

- **3.9 MB in the published package**, which is real and was chosen by measurement rather
  than by taste. The 8M checkpoint is twice the size and no better here; the retrieval-tuned
  32M is eight times the size and *worse*. A corpus of short identifiers and one-sentence
  descriptions is not what a larger table's capacity was distilled for.
- **A tokenizer reimplemented rather than depended on.** A static table is a lookup keyed
  by token, so a tokenizer that cuts a word differently returns a real vector for the wrong
  row — silently. The alternative is a native module with a model loader attached, in a
  repository that holds live refresh tokens and enforces a release-age floor. It is 148
  lines with no I/O, and `wordpiece.test.ts` pins it against the reference implementation's
  own output over 512 texts and 8,609 tokens.
- **Longer answers.** Recall rose from 83% to 92%, and finding more means saying more.

## What was rejected

- **An embedding API.** A network call on the request path, an API key per deployment, and
  a vendor in `#server` — which `architecture.test.ts` refuses on its own.
- **A vector database, or vectors in the blob store.** There are hundreds of capabilities,
  not millions. A brute-force scan is 3 ms. Storage would buy nothing and cost an
  invalidation rule.
- **Replacing the lexical ranking.** Measured above: it is worse than the blend, and worse
  than the blend on exactly the queries that name a capability outright.

## Consequences

`matchesQuery` widens with the candidate set. It and `rank` must agree on what a candidate
is — a disagreement makes the endpoint re-read its config for queries that would have
succeeded and skip the re-read for the ones that needed it, both silently — so they share a
file and a floor.

A missing or unreadable table is not an error. It is a ranking that has lost half its
signal and still answers with the other half; failing the search instead would turn a
packaging mistake into an endpoint that cannot find anything.
