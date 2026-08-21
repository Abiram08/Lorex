/** LongMemEval head-to-head benchmark harness and reporting. */

process.env.LOREX_NO_LIMITS = "1";

import { writeFileSync, appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { MockHydraDB } from "../infrastructure/mock-hydradb.js";
import { HydraDBClient, type HydraDBLike } from "../infrastructure/hydradb-client.js";
import { resolveIdentity } from "../infrastructure/identity.js";
import { LorexEngine } from "../engine.js";
import { normalizeSession } from "../ingestion/normalizer.js";
import { splitIntoTokenChunks } from "../ingestion/token-counter.js";
import { loadConfig, hydrateEnvFromDotEnv } from "../infrastructure/config.js";
import {
  TARGET_COMPRESSION_RATIO,
  budgetForHaystack,
  resolveContextBudget,
} from "../domain/compression.js";
import { EvalLlm, resolveProvider, type ResolvedProvider } from "./llm.js";
import {
  judgeQuestion,
  isAbstentionQuestion,
  type JudgeResult,
  type Outcome,
  type QuestionSpec,
} from "./judge.js";
import { buildBaselineContext, type BaselineSession } from "./baseline.js";
import { loadQuestions, loadStratifiedSample, type RawQuestion } from "./dataset.js";

interface ArmTally {
  name: string;
  correct: number;
  wrongAnswer: number;
  abstainedCorrectly: number;
  abstainedIncorrectly: number;
  hallucinated: number;
  contextTokens: number;
  latencyMs: number;
  byCategory: Record<string, { n: number; scored: number }>;
}

function newTally(name: string): ArmTally {
  return {
    name,
    correct: 0,
    wrongAnswer: 0,
    abstainedCorrectly: 0,
    abstainedIncorrectly: 0,
    hallucinated: 0,
    contextTokens: 0,
    latencyMs: 0,
    byCategory: {},
  };
}

function record(tally: ArmTally, category: string, r: JudgeResult, tokens: number, ms: number): void {
  const bucket = (tally.byCategory[category] ??= { n: 0, scored: 0 });
  bucket.n++;
  if (r.scored) bucket.scored++;
  tally.contextTokens += tokens;
  tally.latencyMs += ms;
  switch (r.outcome) {
    case "correct": tally.correct++; break;
    case "wrong_answer": tally.wrongAnswer++; break;
    case "abstained_correctly": tally.abstainedCorrectly++; break;
    case "abstained_incorrectly": tally.abstainedIncorrectly++; break;
    case "hallucinated": tally.hallucinated++; break;
  }
}

function summarize(tally: ArmTally, total: number, absTotal: number) {
  const scored = tally.correct + tally.abstainedCorrectly;
  return {
    arm: tally.name,
    accuracy: total ? scored / total : 0,
    accuracy_pct: total ? `${((scored / total) * 100).toFixed(1)}%` : "n/a",
    correct: tally.correct,
    wrong_answer: tally.wrongAnswer,
    abstained_correctly: tally.abstainedCorrectly,
    abstained_incorrectly: tally.abstainedIncorrectly,
    hallucinated: tally.hallucinated,
    hallucination_rate: absTotal ? tally.hallucinated / absTotal : 0,
    hallucination_rate_pct: absTotal
      ? `${((tally.hallucinated / absTotal) * 100).toFixed(1)}%`
      : "n/a",
    abstention_precision: absTotal
      ? tally.abstainedCorrectly / absTotal
      : 0,
    avg_context_tokens: total ? Math.round(tally.contextTokens / total) : 0,
    avg_latency_ms: total ? Math.round(tally.latencyMs / total) : 0,
    per_category: Object.entries(tally.byCategory).map(([category, b]) => ({
      category,
      n: b.n,
      accuracy: b.n ? b.scored / b.n : 0,
      accuracy_pct: b.n ? `${((b.scored / b.n) * 100).toFixed(1)}%` : "n/a",
    })),
  };
}

function parseArgs(argv: string[]) {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string, fallback?: number) => {
    const v = flag(name);
    return v === undefined ? fallback : Number(v);
  };
  const live = argv.includes("--live");
  return {
    mock: !live,
    inPath: flag("--in"),
    outPath: flag("--out") ?? (live ? "longmemeval-live-results.json" : "longmemeval-sample-results.json"),
    limit: num("--limit"),
    packTokens: num("--pack"),
    baselineWindow: num("--baseline-window", 115_000)!,
    runBaseline: !argv.includes("--no-baseline"),
    autoConfirm: argv.includes("--yes") || argv.includes("-y"),
    noLlmJudge: argv.includes("--no-llm-judge"),
    chunkTokens: num("--chunk"),
    stratify: !argv.includes("--no-stratify"),
    minRelevance: flag("--min-relevance") === undefined ? undefined : Number(flag("--min-relevance")),
    seed: num("--seed", 42)!,
    resume: !argv.includes("--fresh"),
  };
}

type Opts = ReturnType<typeof parseArgs>;

function buildClient(mock: boolean): HydraDBLike {
  if (mock) return new MockHydraDB();
  try {
    return new HydraDBClient(loadConfig());
  } catch {
    const apiKey = (process.env.HYDRA_DB_API_KEY ?? process.env.HYDRADB_API_KEY ?? "").trim();
    if (!apiKey) throw new Error("Live mode requires HYDRA_DB_API_KEY (or run `lorex init`).");
    return new HydraDBClient({
      apiKey,
      baseUrl: (process.env.HYDRADB_BASE_URL ?? "https://api.hydradb.com").replace(/\/+$/, ""),
      timeoutMs: Number(process.env.HYDRADB_TIMEOUT_MS ?? 30_000) || 30_000,
      queueCap: 200,
    });
  }
}

function normalizeDate(dateStr?: string): string | undefined {
  if (!dateStr) return undefined;
  const m = dateStr.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T12:00:00Z`;
    return Number.isNaN(Date.parse(iso)) ? undefined : iso;
  }
  const t = Date.parse(dateStr);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function routeByCategory(q: RawQuestion): {
  mode: "fast" | "thinking";
  asOf?: string;
  type: "memory" | "knowledge" | "all";
  maxResults: number;
} {
  switch (q.question_type) {
    case "temporal-reasoning":
      return { mode: "thinking", asOf: normalizeDate(q.question_date), type: "all", maxResults: 20 };
    case "multi-session":
      return { mode: "thinking", type: "all", maxResults: 20 };
    case "knowledge-update":
      return { mode: "thinking", type: "all", maxResults: 18 };
    default:
      return { mode: "thinking", type: "all", maxResults: 15 };
  }
}

function toSessions(q: RawQuestion): BaselineSession[] {
  const dates = q.haystack_dates ?? [];
  const ids = q.haystack_session_ids ?? [];
  const haystacks = q.haystack_sessions ?? [];
  const fallbackDate = normalizeDate(q.question_date) ?? new Date().toISOString();

  const out: BaselineSession[] = [];
  for (let i = 0; i < haystacks.length; i++) {
    const raw = haystacks[i];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const occurredAt = normalizeDate(dates[i]) ?? fallbackDate;
    const turns = raw
      .map((t) => ({
        role: t.role === "assistant" ? "assistant" : "user",
        content: String(t.content ?? ""),
      }))
      .filter((t) => t.content.trim().length > 0);
    if (turns.length === 0) continue;
    out.push({
      sessionId: String(ids[i] ?? `sess_${i}`).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80),
      occurredAt,
      turns,
    });
  }
  return out;
}

async function ingestHaystack(
  engine: LorexEngine,
  sessions: BaselineSession[],
  database: string,
  collection: string,
  chunkTokens?: number,
): Promise<{ tokens: number; sessions: number }> {
  let tokens = 0;
  let ingested = 0;
  const ids: string[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    const session = normalizeSession(
      s.sessionId,
      database,
      collection,
      s.turns.map((t) => ({
        role: t.role as "user" | "assistant",
        content: t.content,
        occurredAt: s.occurredAt,
      })),
      { startedAt: s.occurredAt, agent: "longmemeval", source: "benchmark", sequence: i },
    );
    tokens += session.tokenCount;

    try {
      const result = await engine.ingestSession(session, {
        indexWait: false,
        maxTokensPerChunk: chunkTokens,
      });
      ids.push(...result.knowledgeIds, ...result.memoryIds);
      ingested++;
    } catch (pipelineError) {
      try {
        const raw = s.turns.map((t) => `${t.role}: ${t.content}`).join("\n");
        for (const part of splitIntoTokenChunks(raw, 2_000)) {
          await engine.learn(part, s.sessionId);
        }
        ingested++;
      } catch (fallbackError) {
        console.warn(
          `  ! session ${s.sessionId} LOST: ${(pipelineError as Error).message} / ${(fallbackError as Error).message}`,
        );
      }
    }
  }

  if (ids.length) {
    await engine.awaitIndexed(ids);
  }

  engine.setCorpusTokens(tokens);
  return { tokens, sessions: ingested };
}

interface QuestionRecord {
  question_id: string;
  category: string;
  is_abstention: boolean;
  haystack_tokens: number;
  sessions: number;
  lorex: {
    outcome: Outcome;
    tokens: number;
    latency_ms: number;
    abstained: boolean;
    reason: string;
    compression_ratio?: number;
    relevance?: number;
    confidence?: number;
  };
  baseline?: { outcome: Outcome; tokens: number; latency_ms: number; truncated: boolean };
}

function checkpointPath(outPath: string): string {
  return `${outPath}.progress.jsonl`;
}

function loadCheckpoint(outPath: string): QuestionRecord[] {
  const p = checkpointPath(outPath);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as QuestionRecord; } catch { return null; } })
    .filter((r): r is QuestionRecord => r !== null);
}

async function confirmCost(
  opts: Opts,
  questionCount: number,
  cfg: ResolvedProvider,
): Promise<boolean> {
  const packTokens = opts.packTokens ?? budgetForHaystack(115_000);
  const perQ =
    (opts.runBaseline ? opts.baselineWindow + 250 : 0) + packTokens + 250;
  const inputTokens = perQ * questionCount;
  const outputTokens = (opts.runBaseline ? 2 : 1) * 320 * questionCount;
  const cost = EvalLlm.projectCost(cfg, inputTokens, outputTokens);

  console.log("\n  ── Judge run ─────────────────────────────────────────");
  console.log(`  Provider         ${cfg.label}`);
  console.log(`  Model            ${cfg.model}`);
  console.log(`  Questions        ${questionCount}`);
  console.log(`  Arms             ${opts.runBaseline ? "flat-window baseline + Lorex" : "Lorex only"}`);
  if (opts.runBaseline) {
    console.log(`  Baseline window  ${opts.baselineWindow.toLocaleString()} tokens/question`);
  }
  console.log(`  Lorex pack       ~${packTokens.toLocaleString()} tokens/question`);
  console.log(`  Input tokens     ~${inputTokens.toLocaleString()}`);
  console.log(
    cfg.metered
      ? `  ESTIMATED COST   ~$${cost.toFixed(2)}`
      : "  ESTIMATED COST   $0 — free tier, rate-limited (costs time, not money)",
  );
  console.log("  ──────────────────────────────────────────────────────");
  if (opts.runBaseline && cfg.metered && cost > 25) {
    console.log("  Tip: --baseline-window 32000 cuts the baseline arm's cost by ~70%,");
    console.log("       and --no-baseline skips it entirely.\n");
  }

  if (opts.autoConfirm) {
    console.log("  --yes supplied, proceeding.\n");
    return true;
  }
  if (!process.stdin.isTTY) {
    console.log("  Non-interactive shell: pass --yes to proceed.\n");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("  Proceed? [y/N] ")).trim().toLowerCase();
  rl.close();
  console.log();
  return answer === "y" || answer === "yes";
}

async function runBenchmark(opts: Opts): Promise<void> {
  const providerCfg = opts.noLlmJudge ? null : resolveProvider();
  const useLlm = providerCfg !== null;
  const model = providerCfg?.model ?? "none";

  if (!useLlm) {
    console.log(
      [
        "",
        "Scoring with the offline LEXICAL scorer.",
        "  It measures whether the gold is RECOVERABLE from the context - a",
        "  retrieval ceiling, not accuracy - and it structurally favours larger",
        "  contexts. Do not tune against it, and never quote it as a result.",
        "  Set ANTHROPIC_API_KEY for the real metric.",
        "",
      ].join("\n"),
    );
  }

  const done = opts.resume ? loadCheckpoint(opts.outPath) : [];
  if (!opts.resume && existsSync(checkpointPath(opts.outPath))) {
    unlinkSync(checkpointPath(opts.outPath));
  }
  if (done.length) {
    console.log(`\n↻ Resuming: ${done.length} question(s) already scored (--fresh to restart).`);
  }

  if (useLlm) {
    const remaining = (opts.limit ?? 500) - done.length;
    if (remaining > 0 && !(await confirmCost(opts, remaining, providerCfg!))) {
      console.log("Aborted — nothing spent.\n");
      return;
    }
  }

  const llm = useLlm ? new EvalLlm(providerCfg!) : null;
  if (llm) console.log(`
Judge: ${llm.label}
`);
  const client = buildClient(opts.mock);

  const rootIdentity = resolveIdentity(process.cwd(), {
    database: process.env.LOREX_EVAL_DB ?? "lorex_longmemeval",
    collection: "root",
  });
  const rootEngine = new LorexEngine(client, rootIdentity, 200);
  await rootEngine.ensureReady();

  const lorexTally = newTally("lorex");
  const baselineTally = newTally("flat-window");
  const records: QuestionRecord[] = [...done];
  let absTotal = records.filter((r) => r.is_abstention).length;

  for (const r of done) {
    record(lorexTally, r.category, fakeJudge(r.lorex.outcome), r.lorex.tokens, r.lorex.latency_ms);
    if (r.baseline) {
      record(baselineTally, r.category, fakeJudge(r.baseline.outcome), r.baseline.tokens, r.baseline.latency_ms);
    }
  }

  const seen = new Set(done.map((r) => r.question_id));
  let n = records.length;
  const runStartedAt = Date.now();

  const questionSource: AsyncIterable<{ question: RawQuestion }> =
    opts.limit && opts.stratify
      ? (async function* () {
          const sample = await loadStratifiedSample(opts.inPath, opts.limit!, opts.seed);
          const spread = new Map<string, number>();
          for (const q of sample) {
            const k = String(q.question_type ?? "unknown");
            spread.set(k, (spread.get(k) ?? 0) + 1);
          }
          console.log(
            `
Stratified sample (seed ${opts.seed}): ` +
              [...spread.entries()].map(([k, v]) => `${k}=${v}`).join(", "),
          );
          for (const q of sample) yield { question: q };
        })()
      : loadQuestions(opts.inPath, { limit: opts.limit });

  let aborted: Error | undefined;
  try {
  for await (const { question: q } of questionSource) {
    const qid = String(q.question_id ?? `q_${n}`);
    if (seen.has(qid)) continue;

    const category = String(q.question_type ?? "unknown");
    const isAbs = isAbstentionQuestion(qid);
    if (isAbs) absTotal++;
    n++;

    const spec: QuestionSpec = {
      questionId: qid,
      question: String(q.question ?? ""),
      goldAnswer: String(q.answer ?? ""),
      isAbstention: isAbs,
    };

    console.log(
      `\n[${n}${opts.limit ? `/${opts.limit}` : ""}] ${category}${isAbs ? " (ABSTENTION)" : ""}: ${spec.question.slice(0, 68)}...`,
    );

    const sessions = toSessions(q);
    const collection = `q_${qid}`.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
    const engine = rootEngine.withCollection(collection);

    const t0 = Date.now();
    const { tokens: haystackTokens, sessions: sessionCount } = await ingestHaystack(
      engine,
      sessions,
      rootIdentity.database,
      collection,
      opts.chunkTokens,
    );
    const ingestMs = Date.now() - t0;

    const route = routeByCategory(q);
    const packBudget = resolveContextBudget(opts.packTokens, haystackTokens);
    const tLorex = Date.now();
    const receipt = await engine.recall({
      query: spec.question,
      asOf: route.asOf,
      mode: route.mode,
      type: route.type,
      maxResults: route.maxResults,
      maxTokens: packBudget,
      minRelevance: opts.minRelevance,
    });
    const lorexContext = receipt.sources
      .map((s) => s.content || s.excerpt || "")
      .filter(Boolean)
      .join("\n\n");
    const lorexJudge = await judgeQuestion(llm, spec, lorexContext, receipt.abstained);
    const lorexMs = Date.now() - tLorex;
    record(lorexTally, category, lorexJudge, receipt.token_cost, lorexMs);

    let baselineRec: QuestionRecord["baseline"];
    if (opts.runBaseline) {
      const tBase = Date.now();
      const flat = buildBaselineContext(sessions, { windowTokens: opts.baselineWindow });
      const baseJudge = await judgeQuestion(llm, spec, flat.context, false);
      const baseMs = Date.now() - tBase;
      record(baselineTally, category, baseJudge, flat.tokens, baseMs);
      baselineRec = {
        outcome: baseJudge.outcome,
        tokens: flat.tokens,
        latency_ms: baseMs,
        truncated: flat.truncated,
      };
    }

    if (receipt.request_id) {
      try {
        await engine.report({
          requestId: receipt.request_id,
          answer: spec.goldAnswer,
          rating: lorexJudge.scored ? "positive" : "negative",
          feedback: lorexJudge.reason,
        });
      } catch {  }
    }

    const rec: QuestionRecord = {
      question_id: qid,
      category,
      is_abstention: isAbs,
      haystack_tokens: haystackTokens,
      sessions: sessionCount,
      lorex: {
        outcome: lorexJudge.outcome,
        tokens: receipt.token_cost,
        latency_ms: lorexMs,
        abstained: receipt.abstained,
        reason: lorexJudge.reason,
        compression_ratio: receipt.compression?.compression_ratio,
        relevance: receipt.relevance,
        confidence: receipt.confidence,
      },
      baseline: baselineRec,
    };
    records.push(rec);
    appendFileSync(checkpointPath(opts.outPath), JSON.stringify(rec) + "\n");

    const completedThisRun = records.length - done.length;
    const perQuestionMs = (Date.now() - runStartedAt) / Math.max(1, completedThisRun);
    const remaining = Math.max(0, (opts.limit ?? 500) - records.length);
    const etaMin = Math.round((perQuestionMs * remaining) / 60_000);

    console.log(
      `  lorex=${mark(lorexJudge.outcome)} ${lorexJudge.outcome}` +
        ` · ${receipt.token_cost} tok (${receipt.compression?.compression_ratio ?? "?"}× of ${haystackTokens.toLocaleString()})` +
        (baselineRec ? ` │ baseline=${mark(baselineRec.outcome)} ${baselineRec.outcome} · ${baselineRec.tokens.toLocaleString()} tok` : "") +
        ` · ingest ${(ingestMs / 1000).toFixed(1)}s` +
        ` · ${(perQuestionMs / 1000).toFixed(0)}s/q` +
        (remaining > 0 ? ` · ETA ${formatEta(etaMin)}` : ""),
    );
  }

  } catch (error) {
    aborted = error instanceof Error ? error : new Error(String(error));
    const headline = aborted.message.split(/\r?\n/)[0] ?? aborted.message;
    console.error(`\n  Run stopped after ${records.length} question(s): ${headline}`);
    console.error("  Scores so far are checkpointed; re-run without --fresh to continue.\n");
  }

  writeReport(opts, records, lorexTally, baselineTally, absTotal, model, useLlm, llm, aborted);
  if (aborted) process.exitCode = 1;
}

function formatEta(minutes: number): string {
  if (minutes < 1) return "<1 min";
  if (minutes < 90) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function mark(outcome: Outcome): string {
  return outcome === "correct" || outcome === "abstained_correctly"
    ? "✓"
    : outcome === "hallucinated"
      ? "✗!"
      : "✗";
}

function fakeJudge(outcome: Outcome): JudgeResult {
  return {
    outcome,
    scored: outcome === "correct" || outcome === "abstained_correctly",
    invented: outcome === "hallucinated",
    candidateAnswer: "",
    method: "llm-two-stage",
    reason: "restored from checkpoint",
  };
}

function writeReport(
  opts: Opts,
  records: QuestionRecord[],
  lorex: ArmTally,
  baseline: ArmTally,
  absTotal: number,
  model: string,
  useLlm: boolean,
  llm: EvalLlm | null,
  aborted?: Error,
): void {
  const total = records.length;
  const withBaseline = records.filter((r) => r.baseline).length;

  const haystacks = records.map((r) => r.haystack_tokens).filter((t) => t > 0);
  const avgHaystack = haystacks.length
    ? Math.round(haystacks.reduce((a, b) => a + b, 0) / haystacks.length)
    : 0;
  const avgPack = total
    ? Math.round(records.reduce((a, r) => a + r.lorex.tokens, 0) / total)
    : 0;
  const measuredRatio = avgPack > 0 ? avgHaystack / avgPack : 0;

  const lorexSummary = summarize(lorex, total, absTotal);
  const baselineSummary = withBaseline ? summarize(baseline, withBaseline, absTotal) : null;

  const report = {
    metric: "LongMemEval accuracy (two-stage: answer-from-context, then blind grade)",
    protocol: {
      stage_a: "answer generated from context only — gold answer withheld",
      stage_b: "answer graded against gold — context withheld",
      abstention: "`_abs` questions score correct if and only if the system declined",
      note: "both arms use the same model, prompts and judge; only the context differs",
    },
    mode: opts.mock ? "mock" : "live",
    backend: opts.mock ? "mock-hydradb" : "hydradb-live",
    judge: useLlm && llm
      ? { method: "llm-two-stage", model, provider: llm.label, metered: llm.metered }
      : { method: "offline-lexical", model: null },
    disclaimer: !useLlm
      ? "LEXICAL scoring - a retrieval ceiling, NOT accuracy. Never quote as a result."
      : opts.mock
        ? "MOCK backend with a real LLM judge. A valid accuracy number for THIS retrieval stack, but it measures the bundled mock retriever, not HydraDB. Re-run with --live for a HydraDB claim."
        : "LIVE HydraDB with LLM judge - valid for claims.",
    n: total,
    abstention_questions: absTotal,
    incomplete: aborted
      ? { reason: aborted.message.split(/\r?\n/)[0] ?? aborted.message, scored: total }
      : undefined,

    run: {
      dataset: opts.inPath ?? "data/longmemeval_s.json",
      sampling: opts.limit
        ? (opts.stratify ? `stratified, seed ${opts.seed}` : "first-N (NOT category-balanced)")
        : "full dataset",
      seed: opts.seed,
      pack_budget: opts.packTokens ?? "auto (haystack / 46)",
      chunk_tokens: opts.chunkTokens ?? "default",
      baseline_window: opts.runBaseline ? opts.baselineWindow : null,
      tokenizer: "cl100k_base",
    },

    head_to_head: {
      lorex: lorexSummary,
      baseline: baselineSummary,
      comparable: useLlm,
      deltas:
        baselineSummary && useLlm
          ? {
              accuracy_points: +(
                (lorexSummary.accuracy - baselineSummary.accuracy) * 100
              ).toFixed(1),
              hallucination_points: +(
                (baselineSummary.hallucination_rate - lorexSummary.hallucination_rate) * 100
              ).toFixed(1),
              context_reduction:
                baselineSummary.avg_context_tokens && lorexSummary.avg_context_tokens
                  ? +(baselineSummary.avg_context_tokens / lorexSummary.avg_context_tokens).toFixed(1)
                  : null,
            }
          : null,
      deltas_withheld_reason:
        baselineSummary && !useLlm
          ? "offline lexical scoring measures gold containment, which structurally favours the larger context — run with an LLM judge for a valid comparison"
          : undefined,
    },

    compression: {
      target_ratio: TARGET_COMPRESSION_RATIO,
      avg_haystack_tokens: avgHaystack,
      avg_pack_tokens: avgPack,
      measured_ratio: +measuredRatio.toFixed(1),
      meets_target: measuredRatio >= TARGET_COMPRESSION_RATIO,
      note: "budget is derived from each question's measured haystack, so the ratio is enforced, not observed",
    },

    llm_usage: llm
      ? {
          calls: llm.ledger.calls,
          input_tokens: llm.ledger.inputTokens,
          output_tokens: llm.ledger.outputTokens,
          retries: llm.ledger.retries,
          estimated_cost_usd: +llm.ledger.estimatedCostUsd.toFixed(2),
        }
      : null,

    questions: records,
  };

  writeFileSync(opts.outPath, JSON.stringify(report, null, 2));
  printReport(report as never, opts.outPath);
}

function printReport(r: any, outPath: string): void {
  const L = r.head_to_head.lorex;
  const B = r.head_to_head.baseline;
  const pad = (s: string, n: number) => s.padEnd(n);

  console.log("\n" + "═".repeat(66));
  console.log("  LONGMEMEVAL — HEAD TO HEAD");
  console.log(`  ${r.n} questions · ${r.abstention_questions} abstention · judge: ${r.judge.method}`);
  console.log("═".repeat(66));

  console.log(`\n  ${pad("", 26)}${pad("Lorex", 16)}${B ? "Flat window" : ""}`);
  const row = (label: string, a: string, b?: string) =>
    console.log(`  ${pad(label, 26)}${pad(a, 16)}${b ?? ""}`);

  row("Accuracy", L.accuracy_pct, B?.accuracy_pct);
  row("Correct", String(L.correct), B ? String(B.correct) : undefined);
  row("Wrong answer", String(L.wrong_answer), B ? String(B.wrong_answer) : undefined);
  row("Declined correctly", String(L.abstained_correctly), B ? String(B.abstained_correctly) : undefined);
  row("Declined wrongly", String(L.abstained_incorrectly), B ? String(B.abstained_incorrectly) : undefined);
  row("HALLUCINATED", String(L.hallucinated), B ? String(B.hallucinated) : undefined);
  row("Hallucination rate", L.hallucination_rate_pct, B?.hallucination_rate_pct);
  row("Avg context tokens", L.avg_context_tokens.toLocaleString(), B?.avg_context_tokens.toLocaleString());

  if (r.head_to_head.deltas) {
    const d = r.head_to_head.deltas;
    console.log("\n  ── Delta ─────────────────────────────────────────────");
    console.log(`  Accuracy            ${d.accuracy_points >= 0 ? "+" : ""}${d.accuracy_points} points`);
    console.log(`  Hallucination       ${d.hallucination_points >= 0 ? "-" : "+"}${Math.abs(d.hallucination_points)} points`);
    console.log(`  Context             ${d.context_reduction}× fewer tokens`);
  } else if (B) {
    console.log("\n  ── Delta WITHHELD ────────────────────────────────────");
    console.log("  Lexical scoring asks whether the context CONTAINS the gold.");
    console.log("  A 115k window always contains more than a 1.7k pack, so this");
    console.log("  comparison measures size, not quality. Per-arm numbers above");
    console.log("  are still readable as each arm's own retrieval ceiling.");
    console.log("  Run with ANTHROPIC_API_KEY set for a valid head-to-head.");
  }

  console.log("\n  ── Compression ───────────────────────────────────────");
  console.log(`  Avg haystack        ${r.compression.avg_haystack_tokens.toLocaleString()} tokens`);
  console.log(`  Avg pack            ${r.compression.avg_pack_tokens.toLocaleString()} tokens`);
  console.log(
    `  Measured ratio      ${r.compression.measured_ratio}×  (target ${r.compression.target_ratio}×) ${r.compression.meets_target ? "✓" : "✗"}`,
  );

  console.log("\n  Per-category accuracy:");
  for (const c of L.per_category) {
    const bc = B?.per_category.find((x: any) => x.category === c.category);
    console.log(
      `    ${pad(c.category, 30)} ${pad(c.accuracy_pct, 10)}${bc ? `vs ${bc.accuracy_pct}` : ""}`,
    );
  }

  if (r.llm_usage) {
    console.log(`\n  LLM spend: $${r.llm_usage.estimated_cost_usd} (${r.llm_usage.calls} calls)`);
  }
  console.log(`\n  Wrote ${outPath}`);
  if (r.mode === "mock") console.log("  ⚠ MOCK — not benchmark evidence.");
  console.log("═".repeat(66) + "\n");
}

async function main() {
  hydrateEnvFromDotEnv();
  const opts = parseArgs(process.argv.slice(2));
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║  Lorex × HydraDB — LongMemEval head-to-head                    ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  await runBenchmark(opts);
}

main().catch((err) => {
  console.error("\nBenchmark failed:", err);
  process.exit(1);
});
