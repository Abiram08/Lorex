---
name: lorex-memory
description: Persistent project memory via Lorex. Recall past decisions before answering about prior work; save decisions, preferences, and corrections as they happen.
---

# Lorex memory

You have project memory tools (MCP: recall, remember, handoff, resume) and CLI equivalents (`npx -y @lorex/cli ask`, `npx -y @lorex/cli add`).

## When to recall

Before answering questions about prior work, past decisions, user preferences,
or "why is it like this" — recall first. Skip recall for pure coding tasks
where the full context is already in front of you.

## When to save

- After an architecture or library decision → remember it with the reason
- When the user states a preference → remember it with scope: global
- When correcting a previous approach → remember the correction
- When finishing a unit of work → handoff with the decision + next step

Keep it to durable facts. Session chatter is captured automatically; only
save what the next session would need.
