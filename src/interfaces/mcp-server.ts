/** MCP server exposing Lorex operations as agent-callable tools. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LorexEngine } from "../engine.js";
import { LIMITS } from "../infrastructure/limits.js";
import { VERSION } from "../infrastructure/version.js";
import { RateLimitError } from "../infrastructure/rate-limiter.js";
import { HydraDBError } from "../infrastructure/hydradb-client.js";

const RememberSchema = z.object({
  fact: z.string().min(1).max(LIMITS.maxFactChars),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  id: z.string().max(LIMITS.maxIdChars).optional(),
  sourceRef: z.string().max(LIMITS.maxSourceRefChars).optional(),
  ttlSeconds: z.number().int().positive().max(365 * 24 * 3600).optional(),
  because: z.string().max(1000).optional(),
  agent: z.string().max(64).optional(),
});

const LearnSchema = z.object({
  content: z.string().min(1).max(LIMITS.maxContentChars),
  sourceRef: z.string().max(LIMITS.maxSourceRefChars).optional(),
});

const RecallSchema = z.object({
  query: z.string().max(LIMITS.maxQueryChars).optional(),
  asOf: z.string().optional(),
  mode: z.enum(["fast", "thinking"]).optional(),
  type: z.enum(["memory", "knowledge", "all"]).optional(),
  maxResults: z.number().int().min(1).max(LIMITS.maxResults).optional(),
  abstainOnAmbiguity: z.boolean().optional(),
  maxTokens: z.number().int().min(256).max(LIMITS.maxContextTokens).optional()
    .describe(
      `Context pack budget in tokens. Hard cap ${LIMITS.maxContextTokens}; default ${LIMITS.defaultContextTokens}. ` +
      "When the haystack size is known the budget is clamped to haystack/46, so a larger value may be reduced.",
    ),
});

const HistorySchema = z.object({
  factId: z.string().max(LIMITS.maxIdChars).optional(),
  query: z.string().max(LIMITS.maxQueryChars).optional(),
  maxResults: z.number().int().min(1).max(LIMITS.maxResults).optional(),
});

const ListSchema = z.object({
  type: z.enum(["memory", "knowledge", "all"]).optional(),
  maxResults: z.number().int().min(1).max(LIMITS.maxResults).optional(),
});

const ReportSchema = z.object({
  requestId: z.string().min(1),
  answer: z.string().max(LIMITS.maxFactChars).optional(),
  rating: z.enum(["positive", "negative", "neutral"]).optional(),
  feedback: z.string().max(2000).optional(),
  sourceIds: z.array(z.string()).max(50).optional(),
});

const WhySchema = z.object({
  factId: z.string().max(LIMITS.maxIdChars).optional(),
  query: z.string().max(LIMITS.maxQueryChars).optional(),
  maxResults: z.number().int().min(1).max(LIMITS.maxResults).optional(),
});

const HandoffSchema = z.object({
  decision: z.string().min(1).max(LIMITS.maxFactChars),
  nextStep: z.string().max(LIMITS.maxFactChars).optional(),
  sessionId: z.string().max(LIMITS.maxIdChars).optional(),
  agent: z.string().max(64).optional(),
});

const ForgetSchema = z.object({
  factId: z.string().max(LIMITS.maxIdChars).optional(),
  query: z.string().max(LIMITS.maxQueryChars).optional(),
});

const CaptureSessionSchema = z.object({
  sessionId: z.string().min(1).max(LIMITS.maxIdChars),
  startedAt: z.string().optional(),
  turns: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(LIMITS.maxTurnChars),
    occurredAt: z.string().optional(),
  })).min(1).max(LIMITS.maxSessionTurns),
});

export function createServer(engine: LorexEngine): Server {
  const server = new Server(
    { name: "lorex", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "recall",
        description:
          "Retrieve project context from Lorex. Supports temporal recall via asOf and multi-hop via mode:'thinking'. Returns sources, abstained, abstention_reason, and answer.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            asOf: { type: "string", description: "ISO-8601 date; temporal window filter" },
            mode: { type: "string", enum: ["fast", "thinking"] },
            type: { type: "string", enum: ["memory", "knowledge", "all"] },
            maxResults: { type: "number" },
            maxTokens: { type: "number" },
            abstainOnAmbiguity: {
              type: "boolean",
              description:
                "Also decline when two near-equally-scored values compete (default: flag only, do not abstain).",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "remember",
        description:
          "Store a discrete fact. Pass stable id for supersession when the same decision changes, and `because` to record WHY it changed. Optional ttlSeconds for expiry.",
        inputSchema: {
          type: "object",
          properties: {
            fact: { type: "string" },
            validFrom: { type: "string" },
            validTo: { type: "string" },
            id: { type: "string" },
            sourceRef: { type: "string" },
            ttlSeconds: { type: "number" },
            because: { type: "string", description: "Why this replaces the previous value" },
            agent: { type: "string" },
          },
          required: ["fact"],
          additionalProperties: false,
        },
      },
      {
        name: "learn",
        description: "Store raw grounding content verbatim (docs/transcripts).",
        inputSchema: {
          type: "object",
          properties: { content: { type: "string" }, sourceRef: { type: "string" } },
          required: ["content"],
          additionalProperties: false,
        },
      },
      {
        name: "history",
        description: "Show versions of a fact (supersession timeline).",
        inputSchema: {
          type: "object",
          properties: {
            factId: { type: "string" },
            query: { type: "string" },
            maxResults: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "list",
        description: "Snapshot of recent/project memories (not a full dump).",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["memory", "knowledge", "all"] },
            maxResults: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "resume",
        description: "Session-start snapshot of project memory.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "capture_session",
        description:
          "Ingest a conversation session: normalize → chunk → extract facts → store memory+knowledge.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            startedAt: { type: "string" },
            turns: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" },
                  occurredAt: { type: "string" },
                },
                required: ["role", "content"],
              },
            },
          },
          required: ["sessionId", "turns"],
          additionalProperties: false,
        },
      },
      {
        name: "why",
        description:
          "Explain WHY a fact changed. Walks the supersession chain and returns the recorded reasons in one hop. Says plainly when no reason was ever stated rather than inventing one.",
        inputSchema: {
          type: "object",
          properties: {
            factId: { type: "string", description: "Stable topic key, e.g. db_choice" },
            query: { type: "string", description: "Free text when the topic key is unknown" },
            maxResults: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "handoff",
        description:
          "Hand work to the next agent: record the decision made and the next step. Any agent that opens the same workspace picks this up from `resume` with attribution.",
        inputSchema: {
          type: "object",
          properties: {
            decision: { type: "string", description: "What was decided or completed" },
            nextStep: { type: "string", description: "What the next agent should do" },
            sessionId: { type: "string" },
            agent: { type: "string", description: "Override the auto-detected agent name" },
          },
          required: ["decision"],
          additionalProperties: false,
        },
      },
      {
        name: "forget",
        description: "Soft-delete a fact topic (closes current versions).",
        inputSchema: {
          type: "object",
          properties: {
            factId: { type: "string" },
            query: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "usage",
        description: "Show Lorex rate-limit usage (writes/queries/ingest budget) and pending write queue.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "report",
        description: "Send retrieval feedback to HydraDB /feedback.",
        inputSchema: {
          type: "object",
          properties: {
            requestId: { type: "string" },
            answer: { type: "string" },
            rating: { type: "string", enum: ["positive", "negative", "neutral"] },
            feedback: { type: "string" },
            sourceIds: { type: "array", items: { type: "string" } },
          },
          required: ["requestId"],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    try {
      let receipt;
      switch (name) {
        case "recall": {
          const parsed = RecallSchema.safeParse(args);
          if (!parsed.success) return badArgs(parsed.error.message);
          receipt = await engine.recall(parsed.data);
          break;
        }
        case "remember": {
          const parsed = RememberSchema.safeParse(args);
          if (!parsed.success) return badArgs(parsed.error.message);
          receipt = await engine.remember(parsed.data.fact, parsed.data);
          break;
        }
        case "learn": {
          const parsed = LearnSchema.safeParse(args);
          if (!parsed.success) return badArgs(parsed.error.message);
          receipt = await engine.learn(parsed.data.content, parsed.data.sourceRef);
          break;
        }
        case "history": {
          const parsed = HistorySchema.safeParse(args);
          if (!parsed.success) return badArgs(parsed.error.message);
          receipt = await engine.history(parsed.data);
          break;
        }
        case "list": {
          const parsed = ListSchema.safeParse(args);
          if (!parsed.success) return badArgs(parsed.error.message);
          receipt = await engine.list(parsed.data);
          break;
        }
        case "resume": {
          receipt = await engine.resume();
          break;
        }
        case "usage": {
          const u = engine.usage;
          receipt = {
            op: "usage",
            sources: [],
            mode_used: "fast" as const,
            token_cost: 0,
            abstained: false,
            summary:
              `Writes ${u.writesThisHour}/${u.limits.writesPerHour} per hour, ${u.writesToday}/${u.limits.writesPerDay} today; ` +
              `queries ${u.queriesThisHour}/${u.limits.queriesPerHour} this hour; ` +
              `ingest ${u.ingestTokensToday}/${u.limits.ingestTokensPerDay} tokens today; queue ${engine.queueLength}.`,
            result: u as unknown as Record<string, unknown>,
          };
          break;
        }
        case "report": {
          const parsed = ReportSchema.safeParse(args);
          if (!parsed.success) return badArgs(parsed.error.message);
          receipt = await engine.report(parsed.data);
          break;
        }
        case "why": {
          const parsed = WhySchema.safeParse(args);
          if (!parsed.success) return badArgs(parsed.error.message);
          receipt = await engine.why(parsed.data);
          break;
        }
        case "handoff": {
          const parsed = HandoffSchema.safeParse(args);
          if (!parsed.success) return badArgs(parsed.error.message);
          receipt = await engine.handoff(parsed.data);
          break;
        }
        case "forget": {
          const parsed = ForgetSchema.safeParse(args);
          if (!parsed.success) return badArgs(parsed.error.message);
          receipt = await engine.forget(parsed.data);
          break;
        }
        case "capture_session": {
          const parsed = CaptureSessionSchema.safeParse(args);
          if (!parsed.success) return badArgs(parsed.error.message);
          const identity = engine.getIdentity();
          const { normalizeSession } = await import("../ingestion/normalizer.js");
          const session = normalizeSession(
            parsed.data.sessionId,
            identity.database,
            identity.collection,
            parsed.data.turns.map((t) => ({
              role: t.role,
              content: t.content,
              occurredAt: t.occurredAt,
            })),
            { startedAt: parsed.data.startedAt, agent: "mcp", source: "capture_session" },
          );
          const result = await engine.ingestSession(session);
          receipt = {
            op: "ingest" as const,
            sources: [],
            mode_used: "fast" as const,
            token_cost: result.tokenCount,
            abstained: false,
            summary: `Ingested session ${result.sessionId}: ${result.chunkCount} chunks, ${result.factCount} facts, ~${result.tokenCount} tokens${result.partial ? " (partial)" : ""}`,
            result,
          };
          break;
        }
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }

      return {
        content: [
          { type: "text", text: receipt.summary },
          { type: "text", text: JSON.stringify(receipt, null, 2) },
        ],
        isError: false,
      };
    } catch (e) {
      if (e instanceof RateLimitError) {
        return {
          content: [{
            type: "text",
            text:
              `Rate limited: ${e.message} ` +
              `Do not retry immediately; wait ${e.resetInSeconds}s or inform the user.`,
          }],
          isError: true,
        };
      }
      if (e instanceof HydraDBError) {
        const hint =
          e.kind === "auth"
            ? "Check HYDRA_DB_API_KEY (run `lorex doctor`)."
            : e.kind === "network" || e.kind === "server"
              ? "HydraDB is unreachable or failing; this is transient."
              : "";
        return {
          content: [{ type: "text", text: `HydraDB ${e.kind} error: ${e.message}${hint ? ` ${hint}` : ""}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

function badArgs(message: string) {
  return {
    content: [{ type: "text", text: `Invalid arguments: ${message}` }],
    isError: true,
  };
}

export async function runStdioServer(engine: LorexEngine): Promise<void> {
  const server = createServer(engine);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
