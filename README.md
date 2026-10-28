# Lorex

Lorex is a CLI-first, local memory layer shared by coding agents. It gives a
project one stable workspace, one local SQLite-backed memory collection, and a
set of MCP and lifecycle integrations so supported agents can recall prior
work without copying entire transcripts into every prompt.

Lorex is designed to work without an account, API key, hosted database, or
resident browser service. Core storage, retrieval, source receipts, temporal
history, and abstention all run locally. Optional model and embedding endpoints
can improve extraction or synthesis, but they are not required.

## What works today

The product flow is implemented around one command:

```sh
lorex
```

On the first run in a project, Lorex:

1. Finds the project root and creates a stable workspace ID.
2. Opens one local SQLite store and isolates this project in its own collection.
3. Installs MCP configuration, supported lifecycle hooks, and agent guidance.
4. Preserves unrelated settings already present in agent configuration files.
5. Writes a setup fact as a Claude Code identity and retrieves it through an
   independent OpenCode identity, including source attribution.
6. Prints the workspace, store path, runtime, configured agents, capabilities,
   trust/restart steps, and any actionable failures in the terminal.

On later runs, `lorex` is fast and idempotent. It shows status instead of
reinstalling configuration. It does not open a browser or start a resident
service. The browser interface remains optional behind `lorex console`.

The setup smoke test proves that independent local clients share the same
workspace and store. It does **not** claim that an external agent fired a real
hook; real-agent acceptance is tracked separately.

## Install and run

Lorex requires Node.js 20 or 22.

The npm package has not been published yet. To use the current source checkout:

```sh
git clone https://github.com/Abiram08/Lorex.git
cd Lorex
npm install
npm run build
npm install -g .

cd /path/to/your/project
lorex
```

After `@lorex/cli` is published, the intended public command is:

```sh
npx @lorex/cli
```

Do not advertise `npx lorex`. The npm registry records that a different
`lorex@1.7.3` was unpublished on 2024-09-09, and ownership of that unscoped
name has not been established. The package identity therefore remains
`@lorex/cli`.

### Durable one-shot setup

An npx executable normally lives in an evictable npm cache. Lorex does not
write hooks that depend on that temporary executable. Before writing MCP or
hook commands, one-shot setup installs the exact running package into:

```text
~/.lorex/runtime/<version>/
```

Generated commands point to this managed runtime and continue working offline
after setup. If the durable installation fails, setup stops before writing
hooks and prints a repair command. A global install remains supported but is
not required.

## What setup creates

The new project files are integration files, not additional memory databases:

- `.lorex.json` stores the stable project workspace and optional active task.
- `.mcp.json` connects Claude Code to the local Lorex MCP server.
- `.claude/settings.json` adds Claude lifecycle hooks.
- `.claude/skills/lorex/SKILL.md` installs the Lorex workflow skill.
- `.codex/hooks.json` adds Codex lifecycle hooks.
- `.cursor/mcp.json` and `.cursor/hooks.json` configure Cursor MCP and hooks.
- `opencode.json` adds the OpenCode local MCP server.
- `.grok/config.toml` and `.grok/hooks/lorex.json` configure Grok Build.
- `AGENTS.md` receives a marked Lorex guidance block used by supported agents.
- `.agents/skills/lorex/SKILL.md` is the reusable distributable Lorex skill.

Codex also receives a Lorex MCP entry in `~/.codex/config.toml`. The actual
SQLite database lives under `~/.lorex/local-store.db` by default, not in the
repository. Existing JSON, TOML, hook, and guidance content is merged rather
than replaced. Re-running setup removes stale Lorex hook commands without
removing unrelated user hooks.

## Agent capabilities

Lorex reports configured capabilities explicitly and does not treat a config
file as proof that a hook fired.

### Claude Code

- MCP recall and write tools.
- Small context injection at session start and before prompts.
- Incremental transcript capture at Stop and PreCompact.
- Lorex skill guidance.

### Codex

- MCP recall and write tools.
- Session-start and prompt context hooks.
- Completed-turn, Stop, and PreCompact capture.
- `AGENTS.md` guidance.
- Project hooks must be reviewed and trusted through `/hooks`.

### Cursor

- MCP recall and write tools.
- Native session-start and before-prompt hooks.
- Native completed-response capture through `afterAgentResponse`.

### OpenCode

- MCP recall and write tools.
- `AGENTS.md` guidance.
- Lorex does not claim automatic lifecycle capture for OpenCode.

### Grok Build

- MCP recall and write tools.
- Completed-turn and compaction capture hooks.
- `AGENTS.md` guidance.
- Project integration requires `/hooks-trust`.
- Passive hook output is ignored, so context recall is guided through MCP rather
  than reported as automatic hook injection.

Hosted grok.com cannot directly access a private localhost store. Lorex does
not create a tunnel or hosted dependency.

## Normal workflow

```sh
lorex
lorex add "Sessions use Redis because Atlas timed out"
lorex ask "What stores sessions?"
lorex context "implement session cleanup" --plain --maxTokens 900
lorex handoff --decision "Use Redis for sessions" --next "Add expiry tests"
lorex doctor
lorex hooks status
```

`lorex help --json` exposes the machine-readable CLI command registry. The MCP
server exposes corresponding typed memory operations for agents.

The optional local interface is explicit:

```sh
lorex console
```

It starts the local daemon and opens the browser console. Bare `lorex` never
does this.

## Shared tasks between agents

Lorex can maintain an append-only project task journal so multiple agents can
share decisions, progress, blockers, and handoffs without overwriting one
another:

```sh
lorex task create ISSUE-42 --brief "Fix session cleanup; preserve existing data"
lorex task note --agent claude-code --kind decision --text "Use incremental capture"
lorex task note --agent codex --kind progress --text "Added crash-recovery tests"
lorex task show ISSUE-42
lorex task show ISSUE-42 --after 1 --json
lorex task leave
```

Prompt hooks include a bounded view of the active task. Lorex shares memory and
task context, not Git branches or edit locks; use worktrees or separate branches
for concurrent code changes.

## How learning and evidence work

Lorex keeps exact source evidence and derived facts separate:

1. Session and prompt hooks load a small, token-bounded project context pack.
2. Completed turns and transcript events are captured with user/assistant roles,
   timestamps, session identity, root session identity, and agent attribution.
3. Credentials are redacted before prompts are staged or content is persisted.
4. Exact conversation chunks are stored with `verbatim_source` trust.
5. Only durable user-stated evidence is promoted into extracted facts.
   Assistant prose remains verbatim history and is not treated as a verified
   fact merely because an assistant said it.
6. Facts retain evidence IDs, confidence, versions, supersession links,
   validity windows, reasons, and source receipts.
7. Recall returns supporting sources or abstains when evidence is missing.

Receipts expose agent, trust, source session, root session, source event, and
evidence identifiers. Consumers can distinguish explicit memories, heuristic
extractions, verbatim transcript evidence, and inferred patterns.

Project collections are isolated even though they share the same local SQLite
file. A preference is visible across projects only when explicitly stored with
`--scope global`.

## Capture reliability

The learning harness is designed for retries and interrupted agent sessions:

- Duplicate Stop events are idempotent.
- Pending prompts are written atomically and expire if a generation never
  completes.
- Stop and PreCompact accept supported response-field aliases.
- Long transcripts are processed in bounded batches.
- Capture cursors advance only after complete writes.
- Partial fact writes are retried instead of skipped.
- Transcript truncation and same-size in-place rewrites invalidate stale
  cursors through boundary hashes.
- Claude, Codex/OpenAI Responses, and generic role/content transcript shapes
  preserve exact source text.
- Hook failures identify the agent and event, fail open for the coding agent,
  and explain how to retry or diagnose Lorex.

Pattern learning runs behind session-count and time gates. Lower-confidence
inferences enter a review queue. Applied inferred memories retain their source
IDs and `inferred_pattern` trust and do not silently become user-stated facts.

## Storage and privacy

By default Lorex stores state under `~/.lorex/`:

```text
~/.lorex/local-store.db
~/.lorex/runtime/<version>/
~/.lorex/capture-cursors/
~/.lorex/harness-pending/
```

Core memory remains on the local machine. Lorex does not automatically sync
between machines. Use `lorex export` and `lorex import` for deliberate backup
or transfer. Optional OpenAI-compatible model and embedding endpoints are
configured through environment variables; see [.env.example](.env.example).

## What has been verified

Automated coverage proves:

- clean packed installation and executable creation;
- bare first-run setup without a browser;
- repeat-run idempotence;
- preservation of unrelated agent configuration;
- durable npx-style runtime installation and offline execution afterward;
- execution of the generated Codex hook command as a separate process;
- Agent B retrieving Agent A evidence with agent, trust, and session attribution;
- isolation from a different project collection;
- prompt, response, session-start, Stop, and PreCompact harness paths;
- duplicate events, compaction, restart, large transcript, rewrite, redaction,
  and partial-write recovery;
- real MCP JSON-RPC initialize, tool discovery, remember, and recall flows;
- Node 20 type compatibility and the Node 20/22 CI target while retaining
  `better-sqlite3@12.5.0`, the release line that supports both versions;
- the full engine, SQLite, retrieval, daemon, console, hooks, and package suite.

Before publishing, real installed versions of Claude Code, Codex, Cursor,
OpenCode, and Grok Build must still fire their lifecycle hooks end to end. A
configuration-file check and generated-command test are intentionally not
reported as proof of an external agent event. Complete real-agent acceptance
before publishing a release.

## Develop and verify

```sh
npm install
npm run typecheck
npm test
npm run test:package
npm run audit:prod
```

`npm test` runs the engine and integration suite. `npm run test:package` packs
and installs the exact npm artifact, exercises first and repeated setup,
executes generated hooks, validates offline behavior, and checks project
isolation. `npm run release:check` combines the production audit, typecheck,
build, complete tests, and package smoke test.

License: [MIT](LICENSE). Security reports: [SECURITY.md](SECURITY.md).
