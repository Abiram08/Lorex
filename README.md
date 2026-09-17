# Lorex

**Local-first memory for coding agents.**

Lorex gives Claude Code, Cursor, Codex, and Windsurf a shared memory that
survives sessions — decisions, preferences, and architecture context — stored
locally in SQLite. No cloud, no API key, no setup. Install, wire, done.

```bash
npm install -g @lorex/cli
lorex wire      # connect this project to your agents
```

## Why local-first

Cloud memory tools (Mem0, Zep, Supermemory) need an API key, a network
connection, and trust that your code context leaves the machine. Lorex keeps
everything in `~/.lorex/` — inspectable, backup-able, portable, private.

SQLite + FTS5 gives fast lexical search, WAL mode gives concurrent reads,
and prepared statements keep latency in single-digit milliseconds. Optional
cloud sync is a future phase, not a dependency.

## What it does

- **Shared across agents** — Claude Code records a decision; Cursor picks it
  up from the same workspace with attribution.
- **Temporal** — facts are versioned. Ask `asOf` a past date and the old value
  *is* the answer.
- **Causal** — changes record *why* at write time (`because`), rendered later
  by `lorex why`.
- **Alive** — memories have a lifecycle. Episodes decay (90-day half-life),
  preferences strengthen with repetition, tasks expire, stale facts are pruned.
- **Dreaming** — background extraction finds repeated patterns, recurring
  topics, and correction chains across sessions.
- **Honest** — if stored evidence doesn't support a question, Lorex abstains
  instead of guessing.
- **Evidence-backed** — every operation returns a receipt: sources, scores,
  compression stats, abstention reason.

## Current plan

Build order: CLI (for coding agents) → MCP → SDK. The harness layer
(automatic capture/injection via agent hooks) is the long-term direction;
the memory engine underneath is what we're finishing now.

```
Phase 1 (now):   local SQLite engine + lifecycle + dream + CLI
Phase 2 (next):  harness — hooks as primary flow, CLI as debug surface
Phase 3 (later): optional sync via write-queue replay
```

## Quick start

```bash
npm install -g @lorex/cli
lorex local     # start the HTTP memory API on 127.0.0.1:3777
lorex wire      # write .mcp.json for Claude/Cursor/Windsurf
lorex hooks install --agent claude-code   # auto-load memory every session
lorex doctor    # verify setup with a smoke test
```

## Using it

### From the shell

```bash
lorex add "Session storage moved to Redis because Atlas kept timing out"
lorex ask "what do we use for sessions?"
lorex why --factId session_store
lorex resume --plain
```

### From an agent (MCP)

```bash
lorex start     # MCP server over stdio
```

| Tool | What it does |
|------|--------------|
| `recall` | Query memory (`asOf`, `mode`, opt-in `synthesize`) |
| `remember` | Store a fact — `id` for supersession, `because` for the reason |
| `why` | Walk a fact's supersession chain |
| `handoff` | Record a decision + next step for the next agent |
| `resume` | Session-start pack with attribution + latest handoff |
| `history` | Full version timeline for a fact |
| `learn` | Store grounding content verbatim |
| `list` | Snapshot of recent items |
| `forget` | Soft-delete a fact topic |
| `report` | Send retrieval feedback |
| `capture_session` | Ingest a full chat session |
| `usage` | Rate-limit consumption + pending queue |

### From TypeScript

```ts
import { Lorex } from "@lorex/cli/dist/client.js";
const lorex = new Lorex();
await lorex.add("We use Postgres for analytics");
const r = await lorex.search("which database for analytics?");
```

## Storage

Three backends implement `HydraDBLike`:

| Backend | When | File |
|---|---|---|
| `SqliteStore` (**default**) | normal use | `~/.lorex/local-store.db` |
| `HydraDBClient` | `--cloud` + key | remote API |
| `MockHydraDB` | `--mock` | in-memory (tests, demos) |

## Safety

- **Rate limiting** — persisted caps on writes/queries/ingest tokens.
- **Durable write queue** — failed writes retry from `~/.lorex/queue.jsonl`,
  then dead-letter rather than vanish.
- **Graceful degradation** — backend failures become `unavailable` abstentions.
- **Soft deletes** — forgetting closes validity windows; history stays intact.

## Configuration

| Variable | Purpose |
|---|---|
| `LOREX_WORKSPACE` | Shared memory across agents and machines |
| `LOREX_AGENT` | Override the auto-detected agent name |
| `LOREX_HOME` | Relocate all state; default `~/.lorex` |
| `LOREX_NO_LIMITS` | `1` disables limiters (tests only) |
| `HYDRA_DB_API_KEY` | Only needed for `--cloud` mode |
| `LOREX_LLM_BASE_URL` / `LOREX_LLM_API_KEY` | Opt-in LLM synthesis/extraction |
| `LOREX_EXTRACT` | `llm` enables LLM fact extraction |

## Development

```bash
npm run build
npm run typecheck
npm test            # core unit tests
npm run test:capabilities   # 6 end-to-end capability checks
```

## License

MIT
