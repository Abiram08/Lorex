/**
 * Local model auto-detection. If Ollama is running, wire it up for
 * embeddings and LLM synthesis/extraction with zero configuration.
 * Silent when absent — every caller must treat null as "no models".
 */

export interface LocalModels {
  embedUrl?: string;
  embedModel?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
}

const OLLAMA_URLS = ["http://localhost:11434", "http://127.0.0.1:11434"];

async function ollamaUp(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ollamaHasModel(baseUrl: string, model: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = (data.models ?? []).map((m) => m.name ?? "");
    return names.some((n) => n === model || n.startsWith(`${model}:`));
  } catch {
    return false;
  }
}

/**
 * Resolve model endpoints: explicit env first, Ollama auto-detect second,
 * undefined when nothing is available. Cached per process.
 */
let cached: LocalModels | null = null;

export async function detectLocalModels(): Promise<LocalModels> {
  if (cached) return cached;
  const found: LocalModels = {};

  const explicitEmbed = process.env.LOREX_EMBED_URL?.trim();
  const explicitLlm = process.env.LOREX_LLM_BASE_URL?.trim();
  if (explicitEmbed || explicitLlm) {
    if (explicitEmbed) {
      found.embedUrl = explicitEmbed;
      found.embedModel = process.env.LOREX_EMBED_MODEL?.trim() || "nomic-embed-text";
    }
    if (explicitLlm) {
      found.llmBaseUrl = explicitLlm;
      found.llmApiKey = process.env.LOREX_LLM_API_KEY?.trim() || "ollama";
      found.llmModel = process.env.LOREX_LLM_MODEL?.trim() || process.env.LOREX_SYNTH_MODEL?.trim();
    }
    cached = found;
    return found;
  }

  for (const base of OLLAMA_URLS) {
    if (!(await ollamaUp(base))) continue;
    if (await ollamaHasModel(base, "nomic-embed-text")) {
      found.embedUrl = base;
      found.embedModel = "nomic-embed-text";
    }
    found.llmBaseUrl = `${base}/v1`;
    found.llmApiKey = "ollama";
    break;
  }

  cached = found;
  return found;
}

/** Test hook: clear the process cache. */
export function resetLocalModelsCache(): void {
  cached = null;
}
