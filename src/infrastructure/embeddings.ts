/**
 * Local embeddings: Ollama (`/api/embed`) or any OpenAI-compatible
 * (`/v1/embeddings`) endpoint. Disabled by default — FTS only until
 * LOREX_EMBED_URL is set. Failures are silent; search falls back to FTS.
 */

export interface EmbedProvider {
  embed(texts: string[]): Promise<number[][]>;
  model: string;
}

export function embedConfigFromEnv(): { url?: string; model: string } {
  return {
    url: process.env.LOREX_EMBED_URL?.trim() || undefined,
    model: process.env.LOREX_EMBED_MODEL?.trim() || "nomic-embed-text",
  };
}

async function postJson(url: string, body: unknown, timeoutMs = 20_000): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`embeddings: ${res.status}`);
  return res.json() as Promise<unknown>;
}

export function ollamaProvider(url: string, model: string): EmbedProvider {
  const base = url.replace(/\/+$/, "");
  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 32) {
        const batch = texts.slice(i, i + 32);
        const data = (await postJson(`${base}/api/embed`, { model, input: batch })) as {
          embeddings?: number[][];
        };
        if (!data.embeddings || data.embeddings.length !== batch.length) {
          throw new Error("embeddings: bad response shape");
        }
        out.push(...data.embeddings);
      }
      return out;
    },
  };
}

export function openAIProvider(url: string, model: string, apiKey?: string): EmbedProvider {
  const base = url.replace(/\/+$/, "");
  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`embeddings: ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const vecs = (data.data ?? []).map((d) => d.embedding).filter((v): v is number[] => Array.isArray(v));
      if (vecs.length !== texts.length) throw new Error("embeddings: bad response shape");
      return vecs;
    },
  };
}

/** Provider from env. Ollama-style unless LOREX_EMBED_OPENAI=1. Null = disabled. */
export function providerFromEnv(): EmbedProvider | null {
  const { url, model } = embedConfigFromEnv();
  if (!url) return null;
  if (process.env.LOREX_EMBED_OPENAI === "1") {
    return openAIProvider(url, model, process.env.LOREX_EMBED_API_KEY);
  }
  return ollamaProvider(url, model);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

export function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function fromBlob(blob: Uint8Array): number[] {
  const view = new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
  return Array.from(view);
}
