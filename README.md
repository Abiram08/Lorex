# Lorex

**Local-first memory for coding agents.**

Lorex is a memory and context layer that sits between your coding agents
(Claude Code, Cursor, Codex, Windsurf) and their work. Every agent that touches
a project reads from and writes to the same persistent store, so knowledge
survives across sessions, across agents, and across machines — without anything
ever leaving your machine.

Paste a whole chat history back into context and you pay for 100k+ tokens of
noise — and the model still can't tell which facts are current. Lorex ingests
sessions, extracts the durable facts, versions them, and serves back only the
relevant, current context when an agent asks.

```
$ lorex why --factId session_store
- 2026-01-10: We use MongoDB for session storage
- 2026-02-02: MongoDB → Redis — because Atlas kept timing out under load
```

## Why local-first

Cloud memory tools need an API key, a network connection, and trust that your
code context leaves the building. Lorex keeps everything in `~/.lorex/`:
a single SQLite file you can inspect, back up, copy, and delete.

SQLite + FTS5 gives fast lexical search with stemming, WAL mode gives
concurrent readers, prepared statements keep queries in single-digit
milliseconds. Point `LOREX_EMBED_URL` at Ollama (or any OpenAI-compatible
endpoint) and search becomes hybrid: FTS + lifecycle + learned signals +
vector similarity, with embeddings cached in the same file. No Docker, no
Postgres, no vector database, no account.

```
$ lorex add "Session storage moved to Redis because Atlas kept timing out"
$ lorex ask "what do we use for sessions?"
Redis — session storage moved from MongoDB because Atlas kept timing out.
```

## What it does

- **Shared across agents** — Claude Code records a decision; Codex on another
  machine picks it up from the same workspace with attribution.
- **Temporal** — facts are versioned. When session storage moved from MongoDB
  to Redis, Lorex knows Redis is current and MongoDB is history. Ask `asOf` a
  past date and the old value *is* the answer.
- **Causal** — changes record *why* at write time (`because`), not rediscovered
  later by re-reading transcripts.
- **Alive** — memories have a lifecycle, not just a row. Episodes decay on a
  90-day half-life, preferences strengthen each time they're repeated, tasks
  expire after 30 days, stale facts get pruned, and a background Dream pass
  finds repeated patterns, recurring topics, and correction chains.
- **Learning** — retrieval feedback (`report`) adjusts per-memory signal, so
  useful memories rank higher and misleading ones sink. Corrections that
  supersede old versions reinforce themselves.
- **Evidence-backed** — every operation returns a receipt: sources used,
  scores, compression stats, abstention reason. Answers are auditable.
- **Honest** — if the stored evidence doesn't support a question, Lorex
  abstains instead of guessing. Sources are still returned; withholding the
  claim and withholding the evidence are separate decisions.
- **Scoped** — `global` scope holds user-level preferences visible from every
  project; project collections stay isolated from each other.
- **Safe to run unattended** — persisted rate limits and ingestion budgets stop
  a runaway agent from melting the local store.

## The harness (where this is going)

Tools the agent must remember to call don't get called. The harness flips
it: memory happens automatically, the agent never knows it's there.

```
Human types: "claude"
      │
      ▼
┌─────────────┐
│ Agent runs  │  ← Claude Code, Cursor, Codex, Windsurf — unmodified
│ normally    │
└──────┬──────┘
       │  lifecycle hooks fire
       ▼
┌─────────────────────────────────┐
│ Lorex harness (invisible layer) │
│                                 │
│ SessionStart → recall relevant  │  inject memory into context
│ PostToolUse  → capture facts    │  extract + store silently
│ Stop         → save turn        │  facts + session state
│ PreCompact   → backup context   │  survive the wipe
│ SessionEnd   → consolidate      │  handoff for next agent
└──────────────┬──────────────────┘
               ▼
┌─────────────────────────────────┐
│ Memory engine (this repo)       │
│ SQLite + FTS5 · typed facts     │
│ lifecycle · dream · signals     │
│ abstention · causality          │
└─────────────────────────────────┘
```

Build order: CLI (for coding agents) → MCP → SDK → harness.

```
Phase 1 (now):   local SQLite engine + lifecycle + dream + CLI
Phase 2 (next):  harness — hooks as primary flow, CLI as debug surface
Phase 3 (later): optional sync via export/import replay
```

Design rules:

- **Fail-open** — any hook error is a silent no-op; the session proceeds
  without memory rather than blocking the agent.
- **One-shot injection** — memory loads once at session start, not every
  turn. Keeps LLM cache stable and avoids responding to the memory block
  instead of the user.
- **Keyless by default** — capture, recall, lifecycle, and Dream all work
  with zero LLM calls. LLM extraction/synthesis stay opt-in.
- **CLI as debug surface** — once the harness is primary, `lorex doctor`,
  `lorex list`, and `lorex graph` exist for humans to inspect what the
  harness did, not as the way memory gets written.

`lorex wire` + `lorex hooks install` are the first slice of this: they write
the agent configs today so SessionStart/Stop hooks already load and save
memory. The full harness (per-tool-call capture, compaction survival,
cross-agent handoff) builds on the same hook points.

## Quick start

One command, nothing to install:

```bash
npx @lorex/cli setup
```

Or paste this into your agent (Claude Code, Cursor, Codex, Windsurf) and
it does the rest:

> Set up Lorex memory for this project by running `npx @lorex/cli setup`

Claude Code can also install the plugin directly:

```
/plugin marketplace add <your-lorex-repo-url>
/plugin install lorex
```

Setup wires MCP + hooks + skill and verifies with a smoke test. No login.
No API key. No account. Daily use is three commands: `add`, `ask`, `lorex`
(status). Prefer a global install: `npm install -g @lorex/cli`, then
`lorex setup`.

## Local server

```bash
lorex local
```

Prints the endpoints, store path, and semantic status:

```
POST /add  | POST /v4/memories   store a fact or document
POST /search | POST /v4/search   recall with answer + sources
GET  /resume                     session-start pack
GET  /profile[?kind=user]        standing state, no query needed
GET  /health                     ok, workspace, agent
```

Bring your own models, fully offline:

```bash
# hybrid semantic search via local Ollama (nomic-embed-text default)
LOREX_EMBED_URL=http://localhost:11434 lorex local

# LLM extraction + synthesis via any OpenAI-compatible endpoint
LOREX_LLM_BASE_URL=http://localhost:11434/v1 LOREX_LLM_API_KEY=ollama lorex local
```

Documents in, memories out — text, markdown, code, PDFs, URLs:

```bash
lorex learn --file ./runbook.md
lorex learn --file ./architecture.pdf
lorex learn --url https://example.com/spec
```

## Connecting agents

`lorex setup` wires everything. Per-agent detail:

| Agent | What setup writes | How memory flows |
|---|---|---|
| Claude Code | `.mcp.json` + `.claude/settings.json` hooks + skill, or `/plugin install lorex` | MCP tools + SessionStart/Stop/PreCompact hooks |
| Codex | `~/.codex/config.toml` + `CODEX.md` | MCP tools + instruction guidance |
| OpenCode | `opencode.json` + `AGENTS.md` | MCP tools + guidance |
| Pi | `~/.pi/agent/mcp.json` + `AGENTS.md` | MCP tools + guidance |
| OMP | `.omp/mcp.json` | MCP tools |
| Aider | `AGENTS.md` conventions | Shell commands (`add`/`ask`/`resume`) — no MCP |
| Cline | VSCode `cline_mcp_settings.json` + `.clinerules` | MCP tools + guidance |
| Cursor / Windsurf / Gemini | available via `lorex hooks install --agent …` | MCP + hooks/rules |

Check state with `lorex hooks status`, remove with `lorex hooks uninstall`.

During setup you choose where memory lives (default `~/.lorex/`).
Override any time with `LOREX_DATA_DIR` or `lorex setup --data-dir <path>`.

## Shared memory

Memory is shared per workspace on your machine — no login, no cloud:

- **Same repo, any agent** — the collection derives from the git remote
  hash, so clones of the same repo share memory while same-named repos
  don't collide. Claude records at 2pm, Cursor reads at 3pm.
- **User-level prefs** — `scope: global` visible from every project.
- **Across machines** — `lorex export` / `lorex import` JSONL dumps.
  Commit the dump to the repo (or sync it) and import on the other side.
  Local rows win on conflict unless `--force`.

## Using it

### From an agent (MCP)

```bash
lorex start     # MCP server over stdio
```

| Tool | What it does |
|------|--------------|
| `recall` | Query memory (`asOf`, `mode`, opt-in `synthesize`); returns the pack, compression stats, and abstention |
| `remember` | Store a fact — `id` for supersession, `because` for the causal reason, `scope: global` for user-level prefs |
| `why` | Walk a fact's supersession chain and return the recorded reasons |
| `handoff` | Record a decision and the next step for whichever agent comes next |
| `resume` | Session-start pack with cross-agent attribution and the latest handoff |
| `history` | Full version timeline for a fact, including superseded versions |
| `learn` | Store grounding content verbatim (runbooks, docs, transcripts) |
| `list` | Snapshot of recent items |
| `forget` | Soft-delete a fact topic (confidence-gated, history preserved) |
| `report` | Send retrieval feedback — adjusts future ranking |
| `dream` | Mine sessions for patterns, persist discoveries with derives edges |
| `consolidate` | Apply expired TTLs, resolve corrections (opt-in prune/merge) |
| `open_loops` | Unfinished work: tasks recorded but never acted on |
| `profile` | Standing user/project state — no query needed |
| `capture_session` | Ingest a full chat session through the pipeline |
| `usage` | Show rate-limit consumption |

### From the shell

```bash
lorex add "Session storage moved to Redis because Atlas kept timing out"
lorex ask "what do we use for sessions?"
lorex remember --fact "Session storage moved to Redis" --id session_store \
               --because "Atlas kept timing out under load"
lorex recall   --query "what do we use for sessions?"
lorex why      --factId session_store
lorex history  --factId session_store
lorex graph    --query "what changed and why" --out graph.html
lorex resume --plain
lorex usage
```

### From TypeScript

```ts
import { Lorex } from "@lorex/cli/dist/client.js";

const lorex = new Lorex(); // http://127.0.0.1:3777
await lorex.add("We use Postgres for analytics");
const r = await lorex.search("which database for analytics?");
if (!r.abstained) console.log(r.answer);
```

### Memory lifecycle in practice

```bash
# Episodes fade, preferences stick, tasks expire — automatically.
lorex remember --fact "Debugging the auth flake"        # episode: decays
lorex remember --fact "Always use TypeScript"           # preference: strengthens
lorex remember --fact "Rotate the staging keys"         # task: expires in 30d

# Tell Lorex what helped and it ranks better next time.
lorex report --requestId req_abc --rating positive --sourceIds v1 v2

# Unfinished work surfaces instead of rotting silently.
lorex open-loops   # (via engine.openLoops / dashboard)
```

### Handoffs across agents

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
attribution. User-level preferences go one level up:

```bash
lorex remember --fact "Always respond with concise diffs" --scope global
# visible from every project collection on this machine
```

## Storage

Two backends implement the store contract:

| Backend | When | Where |
|---|---|---|
| `SqliteStore` (**default**) | normal use — zero setup | `~/.lorex/local-store.db` (or your `--data-dir`) |
| `MockHydraDB` | `--mock` | in-memory (tests, demos) |

The SQLite schema: `memories` (facts + lifecycle columns), `relations`
(supersedes/extends/derives/relates edges), `feedback` (ratings + ground truth),
`query_failures` (recall-gap mining), `profiles` (maintained standing state). FTS5 with porter stemming over text and
fact keys, kept in sync by triggers. Old databases migrate automatically —
new columns are added idempotently on open and the FTS index rebuilds.

Retrieval scoring blends FTS relevance (70%) with lifecycle strength (30%),
plus recency boost and learned feedback signal. Thinking mode adds 1-hop
relation expansion.

## Built for production

Lorex is designed to run unattended inside agents that loop:

- **Rate limiting** — persisted caps on writes/hour, writes/day, queries/hour,
  and ingest tokens/day. Configurable via environment variables; the MCP server
  tells the agent exactly how long to wait instead of failing opaquely.
- **Graceful degradation** — backend failures during recall become
  `unavailable` abstentions, not crashes. Hook failures are fail-open.
- **Soft deletes** — nothing is hard-deleted; forgetting closes validity
  windows so history stays intact. Pruned/expired rows keep `status` markers.
- **Input guards** — payload size caps, zod-validated MCP arguments, JSON body
  cap on the HTTP server, and a confidence gate before any destructive `forget`.

## Context graph & dashboard

Lorex resolves entities (alias-normalized: PostgreSQL, postgres db → one
node), maps supersession and relates edges, and stamps agent authorship:

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
Agent  ──MCP/CLI/HTTP──▶  LorexEngine  ──▶  SQLite (memory + knowledge)
                               │
                               ├── evidence pack, budget from measured haystack
                               ├── temporal windows + supersession chains
                               ├── causal edges (why a value changed)
                               ├── lifecycle (decay, TTL, consolidation, dream)
                               ├── feedback signals + correction learning
                               ├── abstention (claim withheld, evidence kept)
                               ├── rate limiter + cross-process-safe writes
                               └── cross-agent attribution + handoffs
```

```
src/
  domain/          session · event · fact · evidence · causality · compression
                   graph · receipts
  ingestion/       normalizer → deduplicator → chunker → extractor → pipeline
                   session-capture · token-counter · language-packs
  retrieval/       planner → store-retriever → evidence-assembler
  synthesis/       abstention · llm-synthesizer · verify
  infrastructure/  sqlite-store (default) · mock-hydradb (tests)
                   lifecycle · dream · embeddings · config · identity · limits
                   rate-limiter · secrets · errors · paths · store (contract)
  interfaces/      cli · mcp-server · local-server · agent-hooks · client
                   dashboard · graph-server · graph-render
  evaluation/      longmemeval harness
  benchmark/       local-bench (SQLite throughput/latency)
  tests/           core · sqlite · engine-sqlite · retrieval · ingestion
                   server · infrastructure · requirements
```

## Configuration

| Variable | Purpose |
|---|---|
| `LOREX_WORKSPACE` | Shared memory across agents and machines |
| `LOREX_AGENT` | Override the auto-detected agent name |
| `LOREX_DATABASE` / `LOREX_COLLECTION` | Explicit identity, bypassing git derivation |
| `LOREX_HOME` | Relocate all state; default `~/.lorex` |
| `LOREX_DATA_DIR` | Relocate the memory store file |
| `LOREX_MAX_WRITES_PER_HOUR` / `LOREX_MAX_WRITES_PER_DAY` | Rate-limit tuning |
| `LOREX_MAX_QUERIES_PER_HOUR` | Rate-limit tuning |
| `LOREX_MAX_INGEST_TOKENS_PER_DAY` | Daily ingestion budget |
| `LOREX_NO_LIMITS` | Set to `1` to disable limiters (tests/benchmarks only) |
| `LOREX_ABSTAIN_ON_AMBIGUITY` | `1` makes recall decline when two values tie instead of flagging only |
| `LOREX_EXTRACT` | `llm` enables LLM fact extraction (heuristic by default) |
| `LOREX_LLM_BASE_URL` / `LOREX_LLM_API_KEY` | OpenAI-compatible endpoint for opt-in synthesis/extraction |
| `LOREX_SYNTH_MODEL` | Model for opt-in `recall` answer synthesis |
| `LOREX_EMBED_URL` / `LOREX_EMBED_MODEL` | Ollama (or OpenAI-compatible with `LOREX_EMBED_OPENAI=1`) endpoint for hybrid semantic search |
| `LOREX_DATA_DIR` | Relocate the memory store file |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` | Benchmark judge |
| `LOREX_EVAL_MODEL` | Judge model override |

A `.env` file in the working directory is loaded for any variable not already
set in the environment. See [.env.example](.env.example).

## Development

```bash
npm test                  # everything: 10 suites + capabilities + verify
npm run test:core         # domain + engine unit tests
npm run test:sqlite       # SQLite integration (incl. 10k stress test)
npm run test:engine       # engine flows on real SQLite
npm run test:retrieval    # planner + evidence packing
npm run test:ingestion    # normalizer/chunker/dedup/extractor
npm run test:server       # live HTTP server + client
npm run test:hooks        # installers + setup/status CLI runs
npm run test:embeddings   # vectors + hybrid rerank + PDF ingest
npm run test:capabilities # 6 end-to-end capability checks
npm run build
npm run typecheck
```

## License

MIT
