/** Provider-agnostic judge model client with usage accounting. */

import Anthropic from "@anthropic-ai/sdk";

export type Provider = "anthropic" | "gemini" | "openai-compatible";

export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-opus-5",
  gemini: "gemini-3.6-flash",
  "openai-compatible": "llama-3.3-70b-versatile",
};

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface UsageLedger {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  retries: number;
  estimatedCostUsd: number;
}

export interface ResolvedProvider {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  metered: boolean;
  label: string;
}

export function resolveProvider(): ResolvedProvider | null {
  return resolveProviderChain()[0] ?? null;
}

/** Every configured provider, best-first. The benchmark rotates through these
 * when one is rate-limited instead of dying mid-run. */
export function resolveProviderChain(): ResolvedProvider[] {
  const forced = (process.env.LOREX_LLM_PROVIDER ?? "").trim().toLowerCase();
  const model = (process.env.LOREX_EVAL_MODEL ?? "").trim();

  const gemini = (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "").trim();
  const groq = (process.env.GROQ_API_KEY ?? "").trim();
  const custom = (process.env.LOREX_LLM_API_KEY ?? "").trim();
  const customBase = (process.env.LOREX_LLM_BASE_URL ?? "").trim();
  const anthropic = (
    process.env.ANTHROPIC_API_KEY ??
    process.env.ANTHROPIC_AUTH_TOKEN ??
    ""
  ).trim();

  const wants = (p: string) => !forced || forced === p;
  const chain: ResolvedProvider[] = [];
  // A global LOREX_EVAL_MODEL may name a model only one provider hosts
  // (e.g. "stealth/ox-alpha"). Apply it to OpenAI-compatible endpoints, which
  // route by id; native-API providers keep their own defaults unless the id
  // clearly belongs to them.
  const looksGemini = /^gemini|^google\//i.test(model);
  const looksAnthropic = /^claude/i.test(model);

  // Order: explicitly-configured endpoints first (the user chose them
  // deliberately), then free native tiers as failover, then metered last.

  if (wants("openai-compatible") && customBase) {
    const isOpenRouter = /openrouter\.ai/i.test(customBase);
    const looksLikeLocalId = /^(llama|gemma|mixtral)/i.test(model);
    chain.push({
      provider: "openai-compatible",
      model:
        model && !(looksGemini && isOpenRouter)
          ? model
          : isOpenRouter
            ? DEFAULT_OPENROUTER_MODEL
            : looksLikeLocalId || !model
              ? DEFAULT_MODELS["openai-compatible"]
              : model,
      apiKey: custom || "local",
      baseUrl: customBase.replace(/\/+$/, ""),
      metered: false,
      label: isOpenRouter ? "OpenRouter" : `OpenAI-compatible (${customBase})`,
    });
  }
  if (wants("gemini") && gemini) {
    chain.push({
      provider: "gemini",
      model: looksGemini ? model : DEFAULT_MODELS.gemini,
      apiKey: gemini,
      metered: false,
      label: "Google AI Studio (free tier)",
    });
  }
  if (wants("groq") && groq) {
    chain.push({
      provider: "openai-compatible",
      model: !model || looksGemini ? DEFAULT_MODELS["openai-compatible"] : model,
      apiKey: groq,
      baseUrl: "https://api.groq.com/openai/v1",
      metered: false,
      label: "Groq (free tier)",
    });
  }
  if (wants("anthropic") && anthropic) {
    chain.push({
      provider: "anthropic",
      model: looksAnthropic ? model : DEFAULT_MODELS.anthropic,
      apiKey: anthropic,
      metered: true,
      label: "Anthropic API (metered)",
    });
  }
  if (wants("anthropic") && process.env.ANTHROPIC_PROFILE) {
    chain.push({
      provider: "anthropic",
      model: model || DEFAULT_MODELS.anthropic,
      apiKey: "",
      metered: true,
      label: "Anthropic API (profile)",
    });
  }
  return chain;
}

/** Sensible default for OpenRouter: Ox Alpha (stealth/ox-alpha) is free,
 * 1M-context, and a strong reasoner — ideal judge/answer material. Fallback
 * to the auto-router if it rotates away; override with LOREX_EVAL_MODEL. */
export const DEFAULT_OPENROUTER_MODEL = "stealth/ox-alpha";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class LlmRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmRefusalError";
  }
}

export class EvalLlm {
  private cfg: ResolvedProvider;
  private readonly chain: ResolvedProvider[];
  private readonly cooldownUntil = new Map<number, number>();
  private anthropic: Anthropic | null;
  readonly model: string;
  readonly ledger: UsageLedger = {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    retries: 0,
    estimatedCostUsd: 0,
  };

  constructor(cfg?: ResolvedProvider | ResolvedProvider[]) {
    this.chain = cfg ? (Array.isArray(cfg) ? cfg : [cfg]) : resolveProviderChain();
    if (this.chain.length === 0) {
      throw new Error("No LLM credentials found. See `resolveProvider`.");
    }
    this.cfg = this.chain[0]!;
    this.model = this.cfg.model;
    this.anthropic = this.buildAnthropic(this.cfg);
  }

  private buildAnthropic(cfg: ResolvedProvider): Anthropic | null {
    return cfg.provider === "anthropic"
      ? new Anthropic(cfg.apiKey ? { apiKey: cfg.apiKey } : {})
      : null;
  }

  /** First provider not in cooldown, or the one with the least waiting. */
  private pickProvider(excludeFailed: boolean): { cfg: ResolvedProvider; index: number; waitMs: number } {
    const now = Date.now();
    let best = { waitMs: Number.POSITIVE_INFINITY, index: -1 };
    for (let i = 0; i < this.chain.length; i++) {
      if (excludeFailed && i === this.chain.indexOf(this.cfg)) continue;
      const until = this.cooldownUntil.get(i) ?? 0;
      if (until <= now) return { cfg: this.chain[i]!, index: i, waitMs: 0 };
      if (until - now < best.waitMs) best = { waitMs: until - now, index: i };
    }
    if (!excludeFailed && best.index >= 0) {
      return { cfg: this.chain[best.index]!, index: best.index, waitMs: best.waitMs };
    }
    // All cooling down and nothing else to try — stay on current.
    return { cfg: this.cfg, index: this.chain.indexOf(this.cfg), waitMs: 0 };
  }

  private switchTo(index: number): void {
    this.cfg = this.chain[index]!;
    this.anthropic = this.buildAnthropic(this.cfg);
  }

  get label(): string {
    return `${this.cfg.label} · ${this.model}`;
  }
  get metered(): boolean {
    return this.cfg.metered;
  }

  async complete(
    prompt: string,
    opts: { system?: string; maxTokens?: number; effort?: "low" | "medium" | "high" } = {},
  ): Promise<string> {
    const maxTokens = opts.maxTokens ?? 512;
    const MAX_ATTEMPTS = 6;
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const text =
          this.cfg.provider === "anthropic"
            ? await this.callAnthropic(prompt, opts.system, maxTokens, opts.effort ?? "low")
            : this.cfg.provider === "gemini"
              ? await this.callGemini(prompt, opts.system, maxTokens)
              : await this.callOpenAiCompatible(prompt, opts.system, maxTokens);
        this.ledger.calls++;
        return text.trim();
      } catch (e) {
        lastErr = e;
        if (e instanceof LlmRefusalError) throw e;
        const status = (e as { status?: number }).status;
        const rateLimited = status === 429 || status === 402;
        const retryable = rateLimited || status === 408 || (status ?? 0) >= 500 || status === undefined;
        if (!retryable) throw e;

        // Rate-limited: put this provider on cooldown and fail over to the
        // next configured one instead of stalling the whole run.
        if (rateLimited && this.chain.length > 1) {
          const currentIdx = this.chain.indexOf(this.cfg);
          const retryAfter = (e as { retryAfterMs?: number }).retryAfterMs;
          this.cooldownUntil.set(
            currentIdx,
            Date.now() + Math.max(retryAfter ?? 60_000, 60_000),
          );
          const next = this.pickProvider(true);
          if (next.index !== currentIdx) {
            console.warn(
              `lorex-bench: ${this.cfg.label} rate-limited — failing over to ${next.cfg.label}.`,
            );
            this.switchTo(next.index);
            this.ledger.retries++;
            continue; // retry immediately on the fresh provider, same attempt budget
          }
        }

        if (attempt === MAX_ATTEMPTS - 1) throw e;
        const retryAfter = (e as { retryAfterMs?: number }).retryAfterMs;
        const backoff = retryAfter ?? Math.min(60_000, 2_000 * Math.pow(2, attempt));
        this.ledger.retries++;
        await sleep(backoff + Math.random() * 500);
      }
    }
    throw lastErr;
  }

  private async callAnthropic(
    prompt: string,
    system: string | undefined,
    maxTokens: number,
    effort: "low" | "medium" | "high",
  ): Promise<string> {
    const res = await this.anthropic!.messages.create({
      model: this.cfg.model,
      max_tokens: maxTokens,
      output_config: { effort },
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    });

    this.record(res.usage.input_tokens, res.usage.output_tokens);

    if (res.stop_reason === "refusal") {
      throw new LlmRefusalError(
        `Model declined (${res.stop_details?.category ?? "unspecified"})`,
      );
    }
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  private async callGemini(
    prompt: string,
    system: string | undefined,
    maxTokens: number,
  ): Promise<string> {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}` +
      `:generateContent?key=${encodeURIComponent(this.cfg.apiKey)}`;

    const GEMINI_MIN_OUTPUT = 2048;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          maxOutputTokens: Math.max(maxTokens, GEMINI_MIN_OUTPUT),
          temperature: 0,
        },
      }),
    });

    if (!res.ok) throw await httpError(res);
    const j = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    };
    const usage = j.usageMetadata;
    this.record(
      usage?.promptTokenCount ?? 0,
      (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    );

    const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    const finish = j.candidates?.[0]?.finishReason;
    if (!text && finish === "MAX_TOKENS") {
      const err = new Error(
        `Gemini returned no text (finishReason=MAX_TOKENS, thoughts=${usage?.thoughtsTokenCount ?? 0}). Raise maxTokens.`,
      ) as Error & { status: number };
      err.status = 500;
      throw err;
    }
    return text;
  }

  private async callOpenAiCompatible(
    prompt: string,
    system: string | undefined,
    maxTokens: number,
  ): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0,
      }),
    });

    if (!res.ok) throw await httpError(res);
    const j = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    this.record(j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0);
    return j.choices?.[0]?.message?.content ?? "";
  }

  private record(input: number, output: number): void {
    this.ledger.inputTokens += input;
    this.ledger.outputTokens += output;
    if (!this.cfg.metered) return;
    const rate = PRICING[this.model];
    if (!rate) return;
    this.ledger.estimatedCostUsd +=
      (input / 1_000_000) * rate.input + (output / 1_000_000) * rate.output;
  }

  static projectCost(cfg: ResolvedProvider, inputTokens: number, outputTokens: number): number {
    if (!cfg.metered) return 0;
    const rate = PRICING[cfg.model];
    if (!rate) return 0;
    return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
  }
}

async function httpError(res: Response): Promise<Error & { status: number; retryAfterMs?: number }> {
  const body = await res.text().catch(() => "");

  const hint =
    res.status === 404
      ? " — the judge model id looks retired. Set LOREX_EVAL_MODEL to a current model."
      : res.status === 429
        ? " — rate limited or out of quota. A free tier resets daily; --limit reduces the run."
        : "";

  const err = new Error(
    `LLM ${res.status} ${res.statusText}: ${body.slice(0, 300)}${hint}`,
  ) as Error & { status: number; retryAfterMs?: number };
  err.status = res.status;
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (!Number.isNaN(secs)) err.retryAfterMs = secs * 1000;
  }
  return err;
}
