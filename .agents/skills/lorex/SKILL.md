---
name: lorex
license: MIT
description: >-
  Activate and use Lorex shared local memory with its learning harness for coding
  agents. Use when the user invokes $lorex, asks an agent to remember project work
  across sessions or across Claude Code, Codex, and Cursor, or wants past project
  decisions recalled while coding.
---

# Lorex memory and harness

When invoked, operate Lorex for the current project. Do not stop after describing
its commands. The skill is the agent workflow; the Lorex CLI, SQLite store, MCP
server, and lifecycle hooks provide persistent memory and automatic capture.

## Activate in this project

1. Identify the intended project root. Run all Lorex commands there so agents
   resolve the same workspace. Do not set up Lorex in a parent or unrelated repo.
2. Check whether `lorex` is installed. If absent, install the published
   `@lorex/cli` package globally with `npm install -g @lorex/cli`. If the npm
   package is unavailable and this is the Lorex source checkout, build and
   install that checkout with `npm install -g .`. Otherwise report that the
   engine is missing; a SKILL.md file alone cannot run it.
3. Run `lorex help --json` to confirm the CLI is usable. Check
   `lorex hooks status`. If this project is not wired, run `lorex setup --yes`.
   This creates project scope, MCP connections, agent hooks, and a local
   remember/recall smoke test. Preserve any existing non-Lorex configuration.
4. Run `lorex doctor` and `lorex hooks status`. Resolve failed setup or missing
   hooks before claiming that memory is active. Restart the agents after setup.
   In Codex, open `/hooks` and trust the Lorex project hooks once.

The global CLI install is needed for hooks to keep working without npm network
access. A one-shot `npx` setup may leave later hooks dependent on npm cache or
network. If installation or hook trust is unavailable, say which part is not
active and continue the user's task without claiming automatic memory.

## Work with the memory

- At session start, use the injected context pack. When activating mid-session,
  run `lorex resume --plain`, then `lorex context "<current task>" --plain
  --maxTokens 900` if task-specific history matters. The full transcript stays
  in the local store; only a bounded pack enters the model context.
- Before answering about prior work, decisions, constraints, preferences, or
  corrections, use MCP `recall` when connected or `lorex ask "<question>"`.
  Inspect sources and current status. If evidence is absent or stale, say so.
- Save a durable decision with its reason, a lasting preference, or a correction
  using MCP `remember` or `lorex add "<fact because reason>"`. Use
  `--scope global` only for preferences intended across projects. Do not store
  credentials, speculation, or transient chat as durable facts.
- When work ends with a concrete next step, use `lorex handoff --decision
  "<decision>" --next "<next step>"`. The Stop and PreCompact hooks capture
  supported session events automatically; do not ingest the same transcript
  again just because the skill ran.
- If the project has an active shared task (`lorex status`), read its recent
  events with `lorex task show`. After a concrete decision, blocker, or
  milestone, append a short sourced update, for example `lorex task note
  --kind decision --text "..."` (also supports blocker, progress, handoff).
  Other agents see the new
  entry on their next prompt. Do not treat another agent's note as verified
  code state; inspect the checkout before relying on it. Lorex shares task
  context, not branches or edit locks.

## Verify the harness

`lorex doctor` proves the local store can write and recall; it does not prove a
real agent fired a lifecycle hook. After the first completed agent turn, start
a new session in the same project and recall a distinctive decision. Check
`lorex hooks status` and the agent's hook view if it is missing. Then recall it
from a second supported agent in that project before claiming cross-agent
memory works. Claude Code captures its hook-provided transcript; Codex and
Cursor capture supported prompt/response hook events. Other agents may have
MCP or guidance without automatic learning.

Use `lorex` to open the local console and inspect memories, activity, and the
local API. Lorex shares memory on the same machine and project scope; it does
not automatically sync the SQLite file across machines or remove the model's
context-window limit. Consult `lorex help --json` for the current command
surface when troubleshooting.
