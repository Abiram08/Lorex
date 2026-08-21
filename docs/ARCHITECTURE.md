# Architecture

Lorex is an agent memory and context layer built on HydraDB. HydraDB owns
storage and retrieval; Lorex is the policy layer that makes retrieved context
trustworthy for agents: versioning, causality, budgeting, abstention, identity,
and the MCP surface.

## Layers

```
interfaces/       cli · mcp-server · dashboard · graph-server/graph-render
engine.ts         LorexEngine — every memory operation, always returns a Receipt
ingestion/        normalizer → deduplicator → chunker → extractor → pipeline
retrieval/        planner → hydradb-retriever → evidence-assembler
synthesis/        abstention policy
domain/           fact · event · receipts · causality · graph · compression (pure logic)
infrastructure/   hydradb-client ⇄ mock-hydradb · rate-limiter · write-queue
                  identity · config · limits
evaluation/       LongMemEval benchmark harness
```

## Key types

**Receipt** (`src/domain/receipts.ts`) — every operation returns one:
`op`, `sources`, `mode_used`, `request_id`, `token_cost`, `abstained`,
`abstention_reason` (7 reasons), `answer`, `context`, `compression`, `disputes`.
Metadata schema version = 2.

**Fact identity** (`src/domain/fact.ts`) — facts are versions keyed by a
heuristic `fact_key` (regex subject patterns, known subject nouns, alias
normalization, SHA-256 content-hash fallback). Each version carries
`valid_from` / `valid_to`; supersession closes old intervals and adds a
HydraDB `supersedes` relation with the recorded reason.

**Causality** (`src/domain/causality.ts`) — reasons are captured at write time:
explicit `because`, or regex-extracted ("because…", "due to…", "switched X from
A to B"). Stored as metadata and relation properties; `why` renders the chain.

**Compression** (`src/domain/compression.ts`) — pack budget is derived from the
measured haystack, not a constant:

```
budget = floor(measured_haystack_tokens / 46)
```

counted with a real BPE tokenizer (`cl100k_base`). Hard cap 2,500 tokens;
receipts report `haystack_measured` so an assumed baseline is never mistaken
for a real one.

## Write flow

`ingestSession()` (`src/ingestion/pipeline.ts`):

1. Normalize session → events (validates timestamp ordering)
2. Deduplicate by role + normalized-content fingerprint
3. Chunk into token-bounded chunks (~400 tokens, prev/next linked)
4. Heuristic fact extraction (durable-signal detection, noise filters,
   confidence scoring)
5. Store: chunks → **knowledge** corpus (`trust: verbatim_source`), facts →
   **memory** corpus with cross-session supersession via an in-memory fact
   index — prior version gets `status: superseded` + closed `valid_to`, new
   version carries reason, from/to values, and a `supersedes` relation

Failed writes fall back to the durable write queue.

## Read flow

`LorexEngine.recall()`:

1. **Planner** classifies intent (current_fact / temporal / multi_session /
   preference / knowledge_update) via keyword heuristics and date extraction;
   picks mode (fast/thinking), corpus type, chronology requirement.
2. **Retriever** queries HydraDB (graph_context in thinking mode, `as_of`
   metadata filters). Network/server errors become `unavailable` results, not
   throws.
3. **Temporal resolution** — `asOf` filters by validity windows; otherwise
   current versions are resolved (deriving supersession when metadata is
   missing).
4. **Dispute detection** — multiple live values for one fact key are flagged.
5. **Evidence assembler** dedupes near-duplicates, sorts (prefer-current >
   score > authoritative-memory > compactness), packs under the token budget,
   guarantees diversity.
6. **Abstention gate** — see below.
7. Template-based answer synthesis (no LLM in the hot path) + Receipt.

## Abstention

Seven reasons: no evidence, low confidence, nothing valid at `asOf`,
unavailable backend, contradictory current values, ambiguous entity, evidence
not relevant to the question.

The primary gate is **lexical overlap** between query words and retrieved text
(`MIN_LEXICAL_RELEVANCE = 0.25`) — because retrieval scores cannot separate
answerable from unanswerable questions. Measured against live HydraDB,
questions with no support anywhere in the store scored 0.65–0.76, the same band
as correctly answered ones. Sources are returned even on abstention.

## Storage model

Two corpora per database/collection: **memory** (facts) and **knowledge**
(verbatim chunks/docs), plus a self-published corpus-stats marker item that
tracks total haystack tokens so the pack budget can be derived from real
history size.

## Hexagonal boundary

`HydraDBClient` (HTTP: concurrency semaphore of 5, exponential backoff with
jitter, retry on rate-limit/server errors, envelope validation) and
`MockHydraDB` (in-process JSON-file persistence, lexical scoring, simulated
graph context) both implement `HydraDBLike`. Every demo, test, and benchmark
runs offline through the mock with zero API calls.
