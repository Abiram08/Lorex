# Production guide

Lorex is built to run unattended inside coding agents that loop. This document
covers the safety machinery and how to tune it.

## Rate limiting

A persisted usage limiter (`~/.lorex/usage.json`) protects the HydraDB quota
from runaway agents. It is enforced inside `LorexEngine`, so every entry point
(MCP, CLI, dashboard) is covered.

| Limit | Default | Env var |
|---|---|---|
| Writes per hour | 120 | `LOREX_MAX_WRITES_PER_HOUR` |
| Writes per day | 1,000 | `LOREX_MAX_WRITES_PER_DAY` |
| Queries per hour | 240 | `LOREX_MAX_QUERIES_PER_HOUR` |
| Ingest tokens per day | 2,000,000 | `LOREX_MAX_INGEST_TOKENS_PER_DAY` |

- Counters roll over on fixed hour/day windows and survive restarts.
- When a cap is hit, the operation throws `RateLimitError` carrying the reset
  time. The MCP server translates this into an explicit instruction to the
  agent: wait N seconds, do not retry immediately.
- Set `LOREX_NO_LIMITS=1` to disable (intended for tests and benchmarks only).
- Set `LOREX_HOME` to relocate all state (`usage.json`, `queue.jsonl`,
  `config.json`, `mock-store.json`) - useful for tests and sandboxes.
- Inspect current consumption with `lorex usage` or the MCP `usage` tool.

What counts as a write: `remember`, `learn`, `handoff`, `report`, and each
session ingestion. Supersession close-outs and the corpus-stats marker count as
writes too (they hit the API), but never throw mid-operation - the entry-point
check already gated them. Queries: `recall`, `history`, `list`, `forget`;
`why` counts 2, `graph` counts 4 (they issue multiple retrievals).

## Durable write queue

Failed writes never vanish. They are persisted to `~/.lorex/queue.jsonl` and
retried:

- Auto-flush every 30 seconds; manual flush on MCP server shutdown
  (SIGINT/SIGTERM).
- 5 attempts maximum, then the item is dead-lettered to
  `~/.lorex/queue-dead.jsonl` with the failure reason — nothing is dropped
  silently.
- Capacity 500 (`LOREX_QUEUE_CAP`); when full, the oldest item is evicted to
  the dead-letter file first.

Permanent failures (auth, rejected payload) are not queued — they surface
immediately so misconfiguration is visible instead of retrying forever.

## Failure handling

- **Recall is read-only safe.** Network/server errors during retrieval become
  `unavailable` abstentions with sources withheld but the receipt intact — the
  agent sees "service unavailable", not a stack trace.
- **Supersession ordering.** A new fact version is written before the old one
  is closed, so a failed write can never leave a fact with no live version.
- **Soft deletes everywhere.** `forget` and supersession close validity
  windows; history remains queryable via `asOf`.
- **Confidence-gated forget.** Query-only forget requires a minimum match
  score (0.35) or it abstains rather than deleting the wrong topic.

## Input guards

Shared limits (`src/infrastructure/limits.ts`) are enforced in the engine and
mirrored as zod schemas in the MCP server:

| Guard | Cap |
|---|---|
| Fact / decision length | 8,000 chars |
| Learn content | 200,000 chars |
| Session turns | 2,000 × 50,000 chars |
| Query length | 4,000 chars |
| Max results | 50 (client hard cap) |
| Context pack budget | hard cap 2,500 tokens |

## HTTP client resilience

`HydraDBClient` includes:

- Concurrency semaphore (5 in-flight requests)
- Exponential backoff with jitter (500ms base, 15s max)
- Retry on rate-limit (honoring `Retry-After`) and 5xx errors
- Response envelope validation with typed error kinds:
  `network | auth | rate_limit | server | client | not_ready`

## Identity & isolation

Memory is scoped by database + collection:

- Explicit override (`LOREX_DATABASE` / `LOREX_COLLECTION`) wins
- Otherwise derived from git: database = hash of user identity, collection =
  hash of the remote URL (labels are redacted, raw hashes are not reversible)
- `LOREX_WORKSPACE` makes sharing explicit and portable across machines
- Agent name is auto-detected from environment variables and stamped on every
  write for attribution

## Deployment checklist

1. `lorex init` — stores the API key in `~/.lorex/config.json` (mode 0600)
2. `lorex doctor` — verifies connectivity, identity, and a full round trip
3. Wire the MCP config into your agent(s)
4. Optionally set `LOREX_WORKSPACE` if multiple agents/machines share memory
5. Review rate limits against your HydraDB plan; tune via env vars
6. Monitor `lorex usage` and the queue files under `~/.lorex/`
