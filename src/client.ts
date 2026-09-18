/** Tiny HTTP client for a `lorex local` server. Zero deps.
 *
 * ```ts
 * import { Lorex } from "@lorex/cli/dist/client.js";
 * const lorex = new Lorex();
 * await lorex.add("Session storage moved to Redis because Atlas timed out");
 * const r = await lorex.search("what do we use for sessions?");
 * ```
 */

export interface AddResult {
  ok: boolean;
  summary?: string;
  result?: unknown;
}

export interface SearchResult {
  answer?: string;
  summary?: string;
  abstained?: boolean;
  sources?: Array<{ excerpt?: string; content?: string; score?: number }>;
}

export interface HealthResult {
  ok: boolean;
  workspace?: string;
  agent?: string;
}

export class LorexError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "LorexError";
  }
}

export class Lorex {
  constructor(private readonly baseUrl = "http://127.0.0.1:3777") {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const opts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(`${this.baseUrl}${path}`, opts);
    const text = await res.text();
    if (!res.ok) throw new LorexError(res.status, `lorex ${path}: ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  async add(text: string, opts: { id?: string; because?: string } = {}): Promise<AddResult> {
    return this.request<AddResult>("POST", "/add", { text, ...opts });
  }

  async search(query: string, opts: { asOf?: string } = {}): Promise<SearchResult> {
    return this.request<SearchResult>("POST", "/search", { query, ...opts });
  }

  async resume(): Promise<SearchResult> {
    return this.request<SearchResult>("GET", "/resume");
  }

  async health(): Promise<HealthResult> {
    return this.request<HealthResult>("GET", "/health");
  }
}
