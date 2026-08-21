/** Runnable demo of cross-agent handoff, causal recall, and abstention. */

import { MockHydraDB } from "./infrastructure/mock-hydradb.js";
import { resolveIdentity } from "./infrastructure/identity.js";
import { LorexEngine } from "./engine.js";

const WORKSPACE = "checkout-rewrite";

function heading(n: number, title: string): void {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  ${n}. ${title}`);
  console.log("─".repeat(64));
}

function say(who: string, what: string): void {
  console.log(`\n  [${who}] ${what}`);
}

function agentEngine(client: MockHydraDB, agent: string): LorexEngine {
  const identity = resolveIdentity(process.cwd(), { workspace: WORKSPACE, agent });
  return new LorexEngine(client, identity, 100);
}

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  LOREX — one memory, every agent that touches the work        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`\n  Workspace: ${WORKSPACE}`);

  const client = new MockHydraDB();

  const claude = agentEngine(client, "claude-code");
  const codex = agentEngine(client, "codex");
  await claude.ensureReady();

  heading(1, "Claude Code does the work and records what it decided");

  await claude.remember("We use MongoDB for session storage", {
    id: "session_store",
    validFrom: "2026-01-10T09:00:00Z",
  });
  say("claude-code", "remember → session store is MongoDB");

  await claude.remember(
    "Switched from MongoDB to Redis for session storage because Atlas kept timing out under load",
    { id: "session_store", validFrom: "2026-02-02T14:30:00Z" },
  );
  say("claude-code", "remember → switched to Redis (reason captured from the sentence)");

  await claude.handoff({
    decision: "Session storage moved to Redis; login path migrated and deployed",
    nextStep: "Migrate the logout path and delete the Mongo session collection",
  });
  say("claude-code", "handoff → decision + next step written");

  heading(2, "Codex opens the same workspace — cold start, full context");

  const resumed = await codex.resume();
  console.log(`\n  ${resumed.summary}`);
  const meta = resumed.result as
    | { contributing_agents?: string[]; handoffs?: Array<{ agent?: string; excerpt: string }> }
    | undefined;
  if (meta?.contributing_agents?.length) {
    console.log(`\n  Agents in this workspace: ${meta.contributing_agents.join(", ")}`);
  }
  console.log(`  Context pack: ${resumed.token_cost} tokens`);
  if (resumed.compression?.haystack_measured) {
    console.log(
      `  Compression:  ${resumed.compression.compression_ratio}× of a ${resumed.compression.haystack_tokens.toLocaleString()}-token history`,
    );
  }

  const current = await codex.recall({ query: "What do we use for session storage?" });
  say("codex", `recall → ${current.abstained ? "abstained" : current.sources[0]?.excerpt ?? "(none)"}`);

  heading(3, "Why did it change? (causal memory, not a re-read)");

  const why = await codex.why({ factId: "session_store" });
  console.log();
  console.log(
    (why.answer ?? why.summary)
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  console.log(`\n  ${why.summary}`);
  console.log(
    "\n  A flat window holds both values with equal standing and the reason,",
  );
  console.log("  if it was ever written, is an unlinked sentence in 115k tokens.");

  heading(4, "What was true in January? (temporal window)");

  const past = await codex.recall({
    query: "session storage",
    asOf: "2026-01-15T00:00:00Z",
  });
  say("codex", `asOf 2026-01-15 → ${past.abstained ? "abstained" : past.sources[0]?.excerpt ?? "(none)"}`);

  heading(5, "Something never discussed — abstain, do not invent");

  const unknown = await codex.recall({
    query: "What is our Kubernetes ingress controller and TLS certificate authority?",
  });
  say(
    "codex",
    unknown.abstained
      ? `abstained (${unknown.abstention_reason}) — no answer invented`
      : `ANSWERED: ${unknown.answer?.slice(0, 100)}`,
  );
  console.log(
    `\n  Sources still returned for inspection: ${unknown.sources.length}` +
      " (evidence is never withheld — only the claim is).",
  );

  console.log(`\n${"═".repeat(64)}`);
  console.log("  Claude Code wrote it. Codex continued from it. Neither");
  console.log("  re-read the transcript, and neither made anything up.");
  console.log("═".repeat(64) + "\n");
}

main().catch((e) => {
  console.error("Demo failed:", e);
  process.exit(1);
});
