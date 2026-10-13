# Releasing Lorex

The npm package is `@lorex/cli`. Publishing is intentionally separate from a
normal commit or push and requires access to the `@lorex` npm scope.

## Before the first release

1. Confirm the maintainer owns or can publish to the `@lorex` npm scope.
2. Add an npm automation token as the GitHub Actions secret `NPM_TOKEN`.
3. Enable GitHub Actions and private vulnerability reporting.
4. Run the clean-install acceptance checklist below on real Claude Code, Codex,
   Cursor, OpenCode, and Grok Build installations.

## Release checklist

1. Update the version in `package.json` and `package-lock.json`.
2. Move relevant `CHANGELOG.md` entries under the new version.
3. Run `npm run release:check`.
4. Confirm `npm view @lorex/cli version` is either absent for the first release
   or older than the version being released.
5. Commit the release, push it, and create a GitHub release tagged `vX.Y.Z`.
6. The release workflow verifies the tag/version match, reruns the release gate,
   and publishes with npm provenance.
7. In a clean directory, run `npm install -g @lorex/cli && lorex setup`, restart
   each agent, and verify recall from a second agent.

## Real-agent acceptance

For each supported lifecycle integration:

- Start in a clean project and run `lorex setup`.
- For Codex, open `/hooks`, review the project hook definitions, and trust them.
- Start a new session and confirm the bounded context pack appears.
- Record a decision, finish the turn, restart the agent, and recall it.
- Compact a long session and confirm the decision survives.
- Disable the network and confirm globally installed hooks still work.
- Break the Lorex command deliberately and confirm the agent remains usable
  (hooks must fail open).
- Use Claude Code to record a decision and Codex or Cursor to recall it from
  the same project.
- Confirm OpenCode v1 and v2 both connect to the local MCP server; the v2
  config places Lorex under `mcp.servers`.
- In Grok Build, trust the project and run `grok mcp doctor lorex`. Confirm
  MCP recall works and capture hooks fire. Grok passive-hook output does not
  inject context, so verify agent-guided MCP recall instead.
- Configure an optional OpenAI-compatible BYOK endpoint with a test key, then
  confirm synthesis and embeddings work without logging or exporting the key.

Record the tested agent and version, Node version, operating system, and result
in the GitHub release notes.
