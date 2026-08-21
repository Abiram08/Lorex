/** Two-stage blind scoring and the five-way outcome taxonomy. */

import { EvalLlm, LlmRefusalError } from "./llm.js";

export const NOT_IN_CONTEXT = "NOT_IN_CONTEXT";

export type Outcome =
  | "correct"
  | "wrong_answer"
  | "abstained_correctly"
  | "abstained_incorrectly"
  | "hallucinated";

export interface JudgeResult {
  outcome: Outcome;
  scored: boolean;
  invented: boolean;
  candidateAnswer: string;
  method: "llm-two-stage" | "offline-lexical";
  reason: string;
}

export interface QuestionSpec {
  questionId: string;
  question: string;
  goldAnswer: string;
  isAbstention: boolean;
}

export function isAbstentionQuestion(questionId: string): boolean {
  return questionId.trim().toLowerCase().endsWith("_abs");
}

const ANSWERER_SYSTEM = [
  "You answer questions using ONLY the provided context from a user's chat history.",
  "",
  "Rules:",
  `- If the context does not contain enough information to answer, reply with exactly: ${NOT_IN_CONTEXT}`,
  "- Never guess, infer beyond the context, or use outside knowledge.",
  "- When the context shows a value that later changed, answer with the most recent value.",
  "- Answer in one short phrase or sentence. No preamble, no explanation, no citations.",
].join("\n");

const GRADER_SYSTEM = [
  "You grade a candidate answer against a reference answer for a memory benchmark.",
  "",
  "Reply with exactly one word on the first line: YES or NO.",
  "YES means the candidate conveys the same fact as the reference.",
  "Accept paraphrases, differing formats, and extra harmless detail.",
  "Reject answers that state a different fact, contradict the reference, or are empty.",
  "On the second line give a reason of at most 12 words.",
].join("\n");

export async function answerFromContext(
  llm: EvalLlm,
  question: string,
  context: string,
): Promise<string> {
  if (!context.trim()) return NOT_IN_CONTEXT;

  const prompt = [
    "CONTEXT FROM CHAT HISTORY:",
    context,
    "",
    `QUESTION: ${question}`,
    "",
    `Answer in one short phrase, or exactly ${NOT_IN_CONTEXT} if the context does not support an answer.`,
  ].join("\n");

  try {
    const raw = await llm.complete(prompt, {
      system: ANSWERER_SYSTEM,
      maxTokens: 256,
      effort: "low",
    });
    return raw.trim() || NOT_IN_CONTEXT;
  } catch (e) {
    if (e instanceof LlmRefusalError) return NOT_IN_CONTEXT;
    throw e;
  }
}

async function gradeAnswer(
  llm: EvalLlm,
  question: string,
  gold: string,
  candidate: string,
): Promise<{ correct: boolean; reason: string }> {
  const prompt = [
    `QUESTION: ${question}`,
    `REFERENCE ANSWER: ${gold}`,
    `CANDIDATE ANSWER: ${candidate}`,
    "",
    "Does the candidate convey the same fact as the reference? YES or NO.",
  ].join("\n");

  const raw = await llm.complete(prompt, {
    system: GRADER_SYSTEM,
    maxTokens: 64,
    effort: "low",
  });

  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? "";
  const correct = /^yes\b/i.test(firstLine);
  const reason = raw.split(/\r?\n/).slice(1).join(" ").trim() || firstLine;
  return { correct, reason };
}

function declined(candidate: string, systemAbstained: boolean): boolean {
  if (systemAbstained) return true;
  const c = candidate.trim().toUpperCase();
  return (
    c === NOT_IN_CONTEXT ||
    c.startsWith(NOT_IN_CONTEXT) ||
    c === "" ||
    /^(I DON'?T KNOW|UNKNOWN|NOT ENOUGH INFORMATION|CANNOT DETERMINE)\b/.test(c)
  );
}

function classify(spec: QuestionSpec, refused: boolean, graderSaidYes: boolean): Outcome {
  if (spec.isAbstention) {
    return refused ? "abstained_correctly" : "hallucinated";
  }
  if (refused) return "abstained_incorrectly";
  return graderSaidYes ? "correct" : "wrong_answer";
}

export async function judgeQuestion(
  llm: EvalLlm | null,
  spec: QuestionSpec,
  context: string,
  systemAbstained: boolean,
): Promise<JudgeResult> {
  if (!llm) return offlineJudge(spec, context, systemAbstained);

  const candidate = systemAbstained
    ? NOT_IN_CONTEXT
    : await answerFromContext(llm, spec.question, context);

  const refused = declined(candidate, systemAbstained);

  if (refused) {
    const outcome = classify(spec, true, false);
    return {
      outcome,
      scored: outcome === "abstained_correctly",
      invented: false,
      candidateAnswer: NOT_IN_CONTEXT,
      method: "llm-two-stage",
      reason: spec.isAbstention
        ? "correctly declined an unanswerable question"
        : "declined a question the history could support",
    };
  }

  const { correct, reason } = await gradeAnswer(llm, spec.question, spec.goldAnswer, candidate);
  const outcome = classify(spec, false, correct);
  return {
    outcome,
    scored: outcome === "correct",
    invented: outcome === "hallucinated",
    candidateAnswer: candidate,
    method: "llm-two-stage",
    reason,
  };
}

function offlineJudge(
  spec: QuestionSpec,
  context: string,
  systemAbstained: boolean,
): JudgeResult {
  const refused = systemAbstained;
  if (refused) {
    const outcome = classify(spec, true, false);
    return {
      outcome,
      scored: outcome === "abstained_correctly",
      invented: false,
      candidateAnswer: NOT_IN_CONTEXT,
      method: "offline-lexical",
      reason: "system abstained",
    };
  }

  const supported = goldSupportedBy(spec.goldAnswer, context);
  const outcome = classify(spec, false, supported);
  return {
    outcome,
    scored: outcome === "correct",
    invented: outcome === "hallucinated",
    candidateAnswer: supported ? "(gold recoverable from context)" : "(gold absent from context)",
    method: "offline-lexical",
    reason: supported ? "gold content words present" : "gold content words absent",
  };
}

const LEXICAL_STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "was", "were", "have",
  "has", "had", "are", "you", "your", "they", "their", "about", "into", "when",
  "what", "which", "there", "then", "than", "them", "his", "her", "its", "it's",
]);

function goldSupportedBy(gold: string, context: string): boolean {
  const words = gold
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !LEXICAL_STOP.has(w));

  if (words.length === 0) return false;
  const ctx = context.toLowerCase();
  const hits = words.filter((w) => ctx.includes(w)).length;
  return hits / words.length >= 0.8;
}
