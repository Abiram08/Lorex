/** Context graph construction from receipt sources and HydraDB relations. */

export type NodeKind =
  | "fact"
  | "superseded"
  | "handoff"
  | "session"
  | "entity"
  | "chunk";

export type EdgeKind =
  | "supersedes"
  | "relates"
  | "authored"
  | "evidence"
  | "next";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  detail?: string;
  agent?: string;
  validFrom?: string;
  validTo?: string;
  factKey?: string;
  inPack?: boolean;
  score?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
}

export interface ContextGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    facts: number;
    superseded: number;
    handoffs: number;
    entities: number;
    chunks: number;
    agents: string[];
    explainedChanges: number;
    totalChanges: number;
  };
  query?: string;
}

interface SourceLike {
  id: string;
  content: string;
  excerpt: string;
  score?: number;
  valid_from?: string;
  valid_to?: string;
  fact_key?: string;
  status?: string;
  agent?: string;
  memory_type?: string;
  reason?: string;
  corpus?: string;
}

export interface HydraGraphContext {
  query_paths?: unknown[];
  chunk_relations?: unknown[];
  chunk_id_to_group_ids?: Record<string, string[]>;
}

export interface HydraRelationSlice {
  entities?: Array<{ id?: string; name?: string; type?: string }>;
  relations?: Array<{ source?: string; target?: string; type?: string; from?: string; to?: string }>;
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

export function buildContextGraph(
  sources: SourceLike[],
  opts: {
    graphContext?: HydraGraphContext;
    relations?: HydraRelationSlice;
    packIds?: Set<string>;
    query?: string;
  } = {},
): ContextGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const agents = new Set<string>();

  const addNode = (n: GraphNode): void => {
    const existing = nodes.get(n.id);
    nodes.set(n.id, existing ? { ...existing, ...n, inPack: existing.inPack || n.inPack } : n);
  };

  const chains = new Map<string, SourceLike[]>();
  const handoffTrail: SourceLike[] = [];

  for (const s of sources) {
    const isSuperseded = s.status === "superseded" || s.status === "forgotten";
    const kind: NodeKind =
      s.memory_type === "handoff"
        ? "handoff"
        : s.corpus === "knowledge"
          ? "chunk"
          : isSuperseded
            ? "superseded"
            : "fact";

    addNode({
      id: s.id,
      kind,
      label: truncate(s.excerpt || s.content, 60),
      detail: s.content,
      agent: s.agent,
      validFrom: s.valid_from,
      validTo: s.valid_to,
      factKey: s.fact_key,
      inPack: opts.packIds ? opts.packIds.has(s.id) : true,
      score: s.score,
    });

    if (s.agent) {
      agents.add(s.agent);
      const agentId = `agent:${s.agent}`;
      addNode({ id: agentId, kind: "entity", label: s.agent });
      edges.push({ source: agentId, target: s.id, kind: "authored" });
    }

    if (s.fact_key && s.corpus !== "knowledge" && s.memory_type !== "handoff") {
      if (!chains.has(s.fact_key)) chains.set(s.fact_key, []);
      chains.get(s.fact_key)!.push(s);
    }
    if (s.memory_type === "handoff") handoffTrail.push(s);
  }

  let explainedChanges = 0;
  let totalChanges = 0;

  for (const [, versions] of chains) {
    if (versions.length < 2) continue;
    const ordered = [...versions].sort(
      (a, b) => Date.parse(a.valid_from ?? "0") - Date.parse(b.valid_from ?? "0"),
    );
    totalChanges++;
    let explained = false;
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!;
      const next = ordered[i]!;
      const reason = next.reason;
      if (reason) explained = true;
      edges.push({
        source: prev.id,
        target: next.id,
        kind: "supersedes",
        label: reason ? `because ${truncate(reason, 48)}` : undefined,
      });
    }
    if (explained) explainedChanges++;
  }

  const orderedHandoffs = [...handoffTrail].sort(
    (a, b) => Date.parse(a.valid_from ?? "0") - Date.parse(b.valid_from ?? "0"),
  );
  for (let i = 1; i < orderedHandoffs.length; i++) {
    const from = orderedHandoffs[i - 1]!;
    const to = orderedHandoffs[i]!;
    edges.push({
      source: from.id,
      target: to.id,
      kind: "next",
      label: to.agent && from.agent && to.agent !== from.agent
        ? `${from.agent} to ${to.agent}`
        : undefined,
    });
  }

  for (const rel of opts.graphContext?.chunk_relations ?? []) {
    const r = rel as Record<string, unknown>;
    const from = r.source ?? r.from ?? r.chunk_id;
    const to = r.target ?? r.to ?? r.related_chunk_id;
    if (typeof from !== "string" || typeof to !== "string") continue;
    if (!nodes.has(from)) addNode({ id: from, kind: "chunk", label: truncate(from, 40) });
    if (!nodes.has(to)) addNode({ id: to, kind: "chunk", label: truncate(to, 40) });
    edges.push({
      source: from,
      target: to,
      kind: "relates",
      label: typeof r.type === "string" ? r.type : undefined,
    });
  }

  for (const path of opts.graphContext?.query_paths ?? []) {
    const p = path as Record<string, unknown>;
    const chunkId = typeof p.chunk_id === "string" ? p.chunk_id : undefined;
    const ents = Array.isArray(p.entities) ? p.entities : [];
    for (const e of ents) {
      if (typeof e !== "string" || e.length < 2) continue;
      const entId = `entity:${e.toLowerCase()}`;
      addNode({ id: entId, kind: "entity", label: e });
      if (chunkId && nodes.has(chunkId)) {
        edges.push({ source: entId, target: chunkId, kind: "relates" });
      }
    }
  }

  for (const entity of opts.relations?.entities ?? []) {
    const name = entity.name ?? entity.id;
    if (!name) continue;
    const id = entity.id ?? `entity:${name.toLowerCase()}`;
    addNode({ id, kind: "entity", label: truncate(name, 32), detail: entity.type });
  }

  for (const rel of opts.relations?.relations ?? []) {
    const from = rel.source ?? rel.from;
    const to = rel.target ?? rel.to;
    if (!from || !to || !nodes.has(from) || !nodes.has(to)) continue;
    edges.push({
      source: from,
      target: to,
      kind: rel.type === "supersedes" ? "supersedes" : "relates",
      label: rel.type,
    });
  }

  const all = [...nodes.values()];
  return {
    nodes: all,
    edges: dedupeEdges(edges),
    query: opts.query,
    stats: {
      facts: all.filter((n) => n.kind === "fact").length,
      superseded: all.filter((n) => n.kind === "superseded").length,
      handoffs: all.filter((n) => n.kind === "handoff").length,
      entities: all.filter((n) => n.kind === "entity").length,
      chunks: all.filter((n) => n.kind === "chunk").length,
      agents: [...agents],
      explainedChanges,
      totalChanges,
    },
  };
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const e of edges) {
    if (e.source === e.target) continue;
    const key = `${e.source}|${e.target}|${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
