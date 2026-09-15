/** Tiny HTTP client for a `lorex local` server. Supermemory-style, zero deps.
 *
 *  ```ts
 *  import { Lorex } from "@lorex/cli/dist/client.js";
 *  const lorex = new Lorex(); // http://127.0.0.1:3777
 *  await lorex.add("Session storage moved to Redis because Atlas timed out");
 *  const r = await lorex.search("what do we use for sessions?");
 *  console.log(r.answer ?? r.summary);
 *  ```
 */

export interface SearchResult {
  answer?: string;
  summary?: string;
  abstained?: boolean;
  sources?: Array<{ excerpt?: string; content?: string; score?: number }>;
}

export class Lorex {
  constructor(private readonly baseUrl = "http://127.0.0.1:3777") {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`lorex ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  }

  /** Store a fact. Put the reason in the text ("... because ...") or pass it. */
  async add(text: string, opts: { id?: string; because?: string } = {}): Promise<{ summary?: string }> {
    return this.post("/add", { text, ...opts });
  }

  /** Recall. Returns answer + sources; check `abstained` before trusting. */
  async search(query: string, opts: { asOf?: string } = {}): Promise<SearchResult> {
    return this.post("/search", { query, ...opts });
  }

  /** Session-start pack: latest handoff + contributing agents + summary. */
  async resume(): Promise<SearchResult> {
    const res = await fetch(`${this.baseUrl}/resume`);
    if (!res.ok) throw new Error(`lorex /resume: ${res.status}`);
    return res.json() as Promise<SearchResult>;
  }

  async health(): Promise<{ ok: boolean; workspace?: string }> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`lorex /health: ${res.status}`);
    return res.json() as Promise<{ ok: boolean; workspace?: string }>;
  }
}
