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

  if (wants("gemini") && gemini) {
    return {
      provider: "gemini",
      model: model || DEFAULT_MODELS.gemini,
      apiKey: gemini,
      metered: false,
      label: "Google AI Studio (free tier)",
    };
  }
  if (wants("groq") && groq) {
    return {
      provider: "openai-compatible",
      model: model || DEFAULT_MODELS["openai-compatible"],
      apiKey: groq,
      baseUrl: "https://api.groq.com/openai/v1",
      metered: false,
      label: "Groq (free tier)",
    };
  }
  if (wants("openai-compatible") && customBase) {
    return {
      provider: "openai-compatible",
      model: model || DEFAULT_MODELS["openai-compatible"],
      apiKey: custom || "local",
      baseUrl: customBase.replace(/\/+$/, ""),
      metered: false,
      label: `OpenAI-compatible (${customBase})`,
    };
  }
  if (wants("anthropic") && anthropic) {
    return {
      provider: "anthropic",
      model: model || DEFAULT_MODELS.anthropic,
      apiKey: anthropic,
      metered: true,
      label: "Anthropic API (metered)",
    };
  }
  if (wants("anthropic") && process.env.ANTHROPIC_PROFILE) {
    return {
      provider: "anthropic",
      model: model || DEFAULT_MODELS.anthropic,
      apiKey: "",
      metered: true,
      label: "Anthropic API (profile)",
    };
  }
  return null;
}

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
  private readonly cfg: ResolvedProvider;
  private readonly anthropic: Anthropic | null;
  readonly model: string;
  readonly ledger: UsageLedger = {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    retries: 0,
    estimatedCostUsd: 0,
  };

  constructor(cfg?: ResolvedProvider) {
    const resolved = cfg ?? resolveProvider();
    if (!resolved) throw new Error("No LLM credentials found. See `resolveProvider`.");
    this.cfg = resolved;
    this.model = resolved.model;
    this.anthropic =
      resolved.provider === "anthropic"
        ? new Anthropic(resolved.apiKey ? { apiKey: resolved.apiKey } : {})
        : null;
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
        const retryable = status === 429 || status === 408 || (status ?? 0) >= 500 || status === undefined;
        if (!retryable || attempt === MAX_ATTEMPTS - 1) throw e;

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
      model: this.model,
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
        model: this.model,
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
