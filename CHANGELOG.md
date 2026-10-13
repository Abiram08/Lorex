# Changelog

Notable changes to Lorex. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added
- Release hardening: a packed-tarball setup smoke test, production dependency
  audit gate, GitHub release workflow with npm provenance, and explicit
  real-agent acceptance checklist.
- HTTP MCP requests now have a structural element cap before SDK validation.
- Codex hook setup documents its required trust review and bounds injected hook
  context explicitly.
- **Session-start context pack** — `engine.contextPack()`, `lorex context [query] [--plain]`,
  and the `context_pack` MCP tool. Recall, then format a typed, budget-bounded
  block (Decisions, Constraints, Preferences, Corrections, Handoffs, Open tasks,
  Facts, Reference) for a harness to inject. Deterministic: no model, no key, no network.
- Claude Code `SessionStart` now injects the context pack (`context --plain`)
  in place of `resume --plain`, in both the installer and the shipped plugin.
- Local HTTP server requires a token for non-loopback binds (`--token` /
  `LOREX_LOCAL_TOKEN`, generated and printed when absent); rate limits return
  `429` with a reset time.
- CI matrix (Node 20/22 × ubuntu/macOS/windows), `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, this changelog, and issue/PR templates.
- `docs/` is now tracked and published with the repository.
- **`lorex reflect`** (and the `reflect` MCP tool) — a read-only memory-quality
  report: exact-duplicate text clusters, topics with more than one current
  version, competing corrections, staleness, expired windows, near-duplicate
  topics that could merge, and query patterns that keep failing. `doctor` points
  at it.
- **`lorex help --json`** — the machine-readable command surface (name, summary,
  usage, aliases), so an agent can discover the CLI. A test reads the dispatch
  table and fails if a command is missing from the registry.
- **Dream runs automatically.** `shouldDream`'s gates (≥5 new sessions, ≥24h
  since the last run) were tested but never called; the session-end hook now runs
  `lorex dream --auto`, which is a no-op until the gates pass. `doctor` reports
  when Dream last ran and how much new material has accrued.
- **Episodes are a real memory type.** Extraction now classifies time-anchored
  session narrative ("today I debugged…") as `episode`, which expires in 30 days
  and decays twice as fast as a fact — session story no longer masquerades as
  durable project truth.

### Fixed
- Updated the MCP SDK, Zod, and transitive production dependencies to patched
  versions; the production npm audit now reports zero known vulnerabilities.
- Documentation no longer implies that a workspace name synchronizes the local
  SQLite store between machines.
- **Global scope never superseded.** A `scope: global` write looked up and closed
  versions in the project collection instead of `global`, so user-level
  preferences accumulated as duplicate currents forever.
- **`forget` could destroy an unrelated topic** from a weak (0.35) match, and
  bypassed the write limiter. It now requires a ≥0.6 match *and* the query's own
  words in the matched text, closes only the matched topic, and is charged
  against the write budget.
- **`asOf` could answer with the wrong era.** An empty time window silently fell
  back to unfiltered history, so `outside_time_window` could never fire. The
  filter is now applied over the full history and an empty window refuses.
- **Inverted IDF made relevance collapse.** Query terms absent from every
  candidate received the *highest* weight, producing false "not relevant"
  abstentions on ordinary questions. Absent terms are now ignored for coverage
  and the anchor is the rarest *present* term.
- **Value-keyed topics collided.** "We use Redis for sessions" and "We use Redis
  for caching" shared one topic key, so one silently superseded the other; the
  purpose word now disambiguates.
- A future-dated `validTo` was written already-superseded.
- `closeFactVersion` did not wait for indexing, so concurrent readers could see
  two live versions.
- Recall sources dropped `fact_key`; `why` could render the corpus-stats row as
  a causal chain.
- Evidence dedup could drop a typed fact in favour of the verbatim chunk
  containing it.
- CLI `VALUE_FLAGS` was incomplete, so some flag values leaked into the
  positional argument of the wrong operation.
- **Redaction no longer destroys legitimate memories.** Every email address was
  being replaced with `[REDACTED email]`, so "contact ops@example.com" was
  silently lost. Credentials are still scrubbed; addresses are content.
  `github_pat_` added, and the `sk-` pattern widened to cover `sk-proj-`/`sk-or-`.
- **MCP tool schemas now share one source of truth with their validators.** The
  advertised JSON schemas carried no bounds while Zod enforced them, so an agent
  following the published schema could be rejected. Bounds live in `BOUNDS` and
  are applied to both; end-to-end checks assert the advertised maximum is
  rejected at +1 and accepted at the boundary.
- **No more silent truncation on document ingest.** A document longer than the
  100-paragraph cap now reports exactly how much was kept and dropped (via the
  Receipt's `partial`/`errors`) instead of quietly discarding the tail.
- **A corrupt `config.json` is no longer overwritten.** Reads still tolerate it so
  the CLI runs with defaults, but a write refuses and names the file, rather than
  replacing whatever the user had with a one-key object.

### Changed
- `scripts/verify.mjs` runs against a throwaway `LOREX_HOME` (it used to delete
  the operator's real `~/.lorex/mock-store.json`) and derives server ports
  instead of hardcoding 3000/4321.
- Removed unreferenced assets; `verify.mjs` moved to `scripts/`.

## [0.3.0]

- Memory engine: temporal versioning with supersession and recorded reasons,
  causal history (`why`), lifecycle with TTL and reinforcement, Dream pattern
  mining, consolidation.
- SQLite + FTS5 store (default) with hybrid semantic search via a local
  embedding endpoint; optional LLM extraction and grounded synthesis.
- Surfaces: CLI, MCP server, local HTTP API, lifecycle hooks for ten harnesses,
  dashboard, and a context graph.
