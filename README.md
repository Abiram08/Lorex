# Lorex

Lorex is a local memory layer for coding agents. Claude Code, Codex, Cursor, OpenCode, and Grok Build
can read and write the same project-scoped SQLite store on one machine. A
learning harness captures supported session events, and a resident service
provides a local console and API. Lorex does not sync between machines or
remove an agent's context-window limit: it retrieves a bounded, relevant pack
when needed.

## Set up

Requires Node.js 20 or newer. Until the npm package is published, install from
this source checkout, then run setup from the project you want agents to remember:

```sh
git clone https://github.com/Abiram08/Lorex.git
cd Lorex && npm install && npm run build && npm install -g .
cd /path/to/your/project && lorex setup
```

After the first npm release, the equivalent one-command setup will be
`npm install -g @lorex/cli && lorex setup`. Do not rely on it yet: the package
is not published.

Restart your agents after setup. In Codex, review and trust the installed
project hooks through `/hooks`; in Grok Build, use `/hooks-trust` for project
hooks and MCP. Run `lorex doctor` and `lorex hooks status` to
check the local store and agent wiring. The global install keeps hooks working
offline; `npx @lorex/cli setup` is useful for a trial but can leave later hooks
dependent on npm cache or network.

OpenCode gets a local MCP server and project guidance (both v1 and v2 config
shapes are supported). Grok Build gets a project MCP server and capture hooks;
its passive hook stdout is ignored, so use the Lorex MCP tools for recall as
directed by `AGENTS.md`. Hosted grok.com cannot read a private localhost store
without a separately configured secure tunnel; Lorex does not create one.

When using an existing source checkout, skip `git clone` and run the three npm
commands above from that checkout.

## Use

```sh
lorex                              # open the local console
lorex add "Sessions use Redis because Atlas timed out"
lorex ask "What stores sessions?"
lorex context "implement session cleanup" --plain --maxTokens 900
lorex handoff --decision "Use Redis for sessions" --next "Add expiry tests"
lorex doctor
```

For two agents working on the same objective, create a shared task in the
project once, then let each agent append progress, decisions, or blockers:

```sh
lorex task create ISSUE-42 --brief "Fix session cleanup; preserve existing data"
lorex task note --agent claude-code --kind decision --text "Use incremental capture"
lorex task note --agent codex --kind progress --text "Added crash-recovery test"
lorex task show ISSUE-42
lorex task show ISSUE-42 --after 1 --json
```

The active task ID is stored in the project's `.lorex.json` (or set
`LOREX_TASK=ISSUE-42`). Prompt hooks read its latest journal events on each
turn, so independent local agents can see one another's updates without
copying chat transcripts. This shares context, not code changes: use separate
Git worktrees or branches if both agents edit code concurrently. Run
`lorex task leave` to stop injecting the task. Task history remains local.

The console shows memories, activity, agent wiring, and the local API. Use
`lorex help --json` for the complete command surface. The local CLI and MCP
tools also support history, corrections, retrieval feedback, export/import,
and a static context graph.

The distributable [Lorex skill](.agents/skills/lorex/SKILL.md) tells an agent
when to recall, save, and verify memory. `lorex setup` installs it alongside
the hooks. The skill is an agent workflow, not a replacement for the CLI,
SQLite store, or learning harness.

## How learning works

- Session start injects a bounded project context pack.
- Supported prompt hooks retrieve task-relevant memory.
- Stop and pre-compact hooks capture supported session events. Claude Code can
  supply its transcript; Codex and Cursor use supported prompt/response hook
  events. A hook must actually fire before the harness can learn from it.
- The engine extracts durable user-stated facts and decisions; assistant prose
  stays in verbatim session history unless independently saved with evidence.
  It tracks changes and reasons,
  and keeps source receipts. Retrieval feedback influences ranking. Pattern
  mining can propose inferences for review; higher-confidence patterns may be
  applied automatically under the configured gates.

Lorex keeps its state under `~/.lorex/` by default. Project collections stay
isolated; explicit global memories can be shared across projects. Use
`lorex export` and `lorex import` for a deliberate backup or transfer. Do not
put secrets into memory. Optional OpenAI-compatible model and embedding
endpoints are configured with environment variables; core local memory needs
no API key or network connection. See [.env.example](.env.example).

## Develop and release

```sh
npm install
npm run typecheck
npm test
npm run test:package
```

`npm test` covers the engine, SQLite, retrieval, harness, hooks, daemon,
console, and CLI verification. `npm run release:check` additionally runs the
production dependency audit and package smoke test. Real-agent hook acceptance
is still required before a release; see [release checklist](docs/RELEASING.md).

License: [MIT](LICENSE). Security reports: [SECURITY.md](SECURITY.md).
