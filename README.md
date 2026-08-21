# Lorex

**Shared memory for AI coding agents.**

Lorex is a memory and context layer that sits between your coding agents
(Claude Code, Cursor, Codex, Windsurf) and their work. Every agent that touches
a project reads from and writes to the same persistent store, so knowledge
survives across sessions, across agents, and across machines.

Paste a whole chat history back into context and you pay for 100k+ tokens of
noise — and the model still can't tell which facts are current. Lorex ingests
sessions, extracts the durable facts, versions them, and serves back only the
relevant, current context when an agent asks.

## What it does

- **Shared across agents** — Claude Code records a decision; Codex on another
  machine picks it up from the same workspace with attribution.
- **Temporal** — facts are versioned. When session storage moved from MongoDB
  to Redis, Lorex knows Redis is current and MongoDB is history. Ask `asOf` a
  past date and the old value *is* the answer.
- **Causal** — changes record *why* at write time (`because`), not rediscovered
  later by re-reading transcripts.
- **Evidence-backed** — every operation returns a receipt: sources used,
  compression stats, abstention reason. Answers are auditable.
- **Honest** — if the stored evidence doesn't support a question, Lorex
  abstains instead of guessing. Sources are still returned; withholding the
  claim and withholding the evidence are separate decisions.
- **Safe to run unattended** — persisted rate limits and ingestion budgets stop
  a runaway agent from burning your HydraDB quota.

```
$ lorex why --factId session_store
- 2026-01-10: We use MongoDB for session storage
- 2026-02-02: MongoDB → Redis — because Atlas kept timing out under load
```

## Quick start

```bash
npm install -g @lorex/cli
lorex init      # guided setup: HydraDB key, workspace, agent wiring
lorex doctor    # verifies connectivity, identity, and a round trip
```

Node.js ≥ 20. Requires a [HydraDB](https://www.hydradb.com) API key.
Every command accepts `--mock` to run offline against the bundled in-process
backend — no key needed:

```bash
npm run demo    # cross-agent continuity, why, and abstention demo
```

## Using it

### From an agent (MCP)

```bash
lorex start     # MCP server over stdio
```

`lorex init` prints the exact MCP config to paste into Claude Code, Cursor,
Windsurf, or Codex.

| Tool | What it does |
|------|--------------|
| `recall` | Query memory (`asOf`, `mode`); returns the pack, compression stats, and abstention |
| `remember` | Store a fact — `id` for supersession, `because` for the causal reason |
| `why` | Walk a fact's supersession chain and return the recorded reasons |
| `handoff` | Record a decision and the next step for whichever agent comes next |
| `resume` | Session-start pack with cross-agent attribution and the latest handoff |
| `history` | Full version timeline for a fact |
| `learn` | Store grounding content verbatim |
| `list` | Snapshot of recent items |
| `forget` | Soft-delete a fact topic (confidence-gated) |
| `report` | Send retrieval feedback back to HydraDB |
| `capture_session` | Ingest a full chat session through the pipeline |
| `usage` | Show rate-limit consumption and pending write queue |
| `usage` | Show rate-limit consumption and pending write queue |

### From the shell

```bash
lorex remember --fact "Session storage moved to Redis" --id session_store \
               --because "Atlas kept timing out under load"
lorex recall   --query "what do we use for sessions?"
lorex why      --factId session_store
lorex graph    --query "what changed and why" --out graph.html
lorex resume
lorex usage
```

## Shared memory across agents

Without a workspace, identity is derived from git — `database` is the user,
`collection` is the repository — so agents share memory only when they run as
the same user on the same clone.

A workspace makes it explicit and portable:

```bash
# Agent A finishes a piece of work
LOREX_WORKSPACE=checkout lorex handoff \
  --decision "Session storage moved to Redis; login path migrated" \
  --next "Migrate the logout path and drop the Mongo collection"

# Agent B, different machine, cold start
LOREX_WORKSPACE=checkout lorex resume
# → Resuming workspace "checkout" as codex. Also worked on by: claude-code.
#   Last handoff (claude-code, 2026-02-02): Session storage moved to Redis…
```

The agent name is detected automatically (`claude-code`, `cursor`, `codex`,
`vscode`, `github-actions`) and stamped on every write, so recall carries
attribution.

## Built for production

Lorex is designed to run unattended inside agents that loop:

- **Rate limiting** — persisted caps on writes/hour, writes/day, queries/hour,
  and ingest tokens/day. Configurable via environment variables; the MCP server
  tells the agent exactly how long to wait instead of failing opaquely.
- **Durable write queue** — failed writes retry from `~/.lorex/queue.jsonl`
  (30s auto-flush, 5 attempts), then dead-letter to a file rather than vanish.
- **Graceful degradation** — network failures during recall become
  `unavailable` abstentions, not crashes.
- **Soft deletes** — nothing is hard-deleted; forgetting closes validity
  windows so history stays intact.
- **Input guards** — payload size caps, zod-validated MCP arguments, and a
  confidence gate before any destructive `forget`.

See [docs/PRODUCTION.md](docs/PRODUCTION.md) for details and tuning.

## Context graph & dashboard

HydraDB resolves entities and maps relations between them. Lorex adds
supersession edges, causal reasons, and agent authorship on top:

```bash
lorex graph --query "what changed and why" --out graph.html   # static file
lorex graph --live                                            # live, redraws as agents write
lorex dashboard                                               # http://127.0.0.1:3000
```

Solid ring = true now; hollow = replaced; red arrow = supersedes, labelled with
the recorded reason; gold outline = made it into the retrieved pack. The graph
is a single self-contained HTML file. The dashboard is a local,
token-authenticated view of stored memory with a live recall console.

## Architecture

```
Agent  ──MCP/CLI──▶  LorexEngine  ──▶  HydraDB (memory + knowledge)
                          │
                          ├── evidence pack, budget derived from measured haystack
                          ├── temporal windows + supersession chains
                          ├── causal edges (why a value changed)
                          ├── abstention (claim withheld, evidence kept)
                          ├── rate limiter + durable write queue
                          └── cross-agent attribution + handoffs
```

```
src/
  domain/          session · event · fact · evidence · causality · compression
                   graph · receipts
  ingestion/       normalizer → deduplicator → chunker → extractor → pipeline
  retrieval/       planner → hydradb-retriever → evidence-assembler
  synthesis/       abstention
  infrastructure/  hydradb-client ⇄ mock-hydradb (both implement HydraDBLike)
                   config · identity · limits · rate-limiter · write-queue
  evaluation/      longmemeval · judge · baseline · llm · dataset
  interfaces/      mcp-server · cli · dashboard · graph-render
```

Lorex does not reimplement a vector database. HydraDB owns storage and
retrieval — memory and knowledge corpora, graph traversal, `as_of` windows,
feedback. Lorex is the agent policy layer: identity, versioning, causality,
pack budget, abstention, rate limiting, MCP.

`MockHydraDB` and `HydraDBClient` both implement `HydraDBLike`, so every demo,
test, and benchmark runs offline with no API calls anywhere.

More detail:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — end-to-end data flow, key types, design decisions
- [docs/PRODUCTION.md](docs/PRODUCTION.md) — rate limits, queues, failure handling, deployment
- [docs/BENCHMARK.md](docs/BENCHMARK.md) — LongMemEval head-to-head harness and methodology

## Configuration

| Variable | Purpose |
|---|---|
| `HYDRA_DB_API_KEY` | HydraDB credential (or `~/.lorex/config.json` via `lorex init`) |
| `HYDRADB_BASE_URL` | Override the API base URL |
| `HYDRADB_TIMEOUT_MS` | Per-request timeout (default 15000) |
| `LOREX_WORKSPACE` | Shared memory across agents and machines |
| `LOREX_AGENT` | Override the auto-detected agent name |
| `LOREX_DATABASE` / `LOREX_COLLECTION` | Explicit identity, bypassing git derivation |
| `LOREX_QUEUE_CAP` | Write-queue capacity (default 500) |
| `LOREX_MAX_WRITES_PER_HOUR` / `LOREX_MAX_WRITES_PER_DAY` | Rate-limit tuning |
| `LOREX_MAX_QUERIES_PER_HOUR` | Rate-limit tuning |
| `LOREX_MAX_INGEST_TOKENS_PER_DAY` | Daily ingestion budget |
| `LOREX_NO_LIMITS` | Set to `1` to disable limiters (tests/benchmarks only) |
| `LOREX_HOME` | Relocate all state (config, queue, usage, mock store); default `~/.lorex` |
| `LOREX_ABSTAIN_ON_AMBIGUITY` | `1` makes recall decline when two values tie instead of flagging only |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` | Benchmark judge |
| `LOREX_EVAL_MODEL` | Judge model override |

A `.env` file in the working directory is loaded for any variable not already
set in the environment. See [.env.example](.env.example).

## Development

```bash
npm test            # core unit tests + end-to-end capability checks
npm run verify      # build + full verification suite
npm run typecheck
```

## License

MIT
