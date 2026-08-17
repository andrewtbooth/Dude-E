/**
 * Reading and accumulating the analyst's answers to clarifying questions.
 *
 * Separate from `route.ts` because a Next route module may only export the
 * handler and its config — and because the thing worth testing here needs no
 * session, database or model.
 */

import type { Refinement } from "@/lib/agent/schema";

export function parseRefinements(raw: unknown): Refinement[] {
  if (!Array.isArray(raw)) return [];
  const parsed: Refinement[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const questionId = typeof record.questionId === "string" ? record.questionId : "";
    const question = typeof record.question === "string" ? record.question : "";
    const answer = typeof record.answer === "string" ? record.answer.trim() : "";
    const declined = record.declined === true;
    // An answer or an explicit declination; not neither. A declination is a
    // fact about what the analyst could establish, and it is the thing the
    // form promises to carry — see Refinement.
    if (questionId && question && (answer || declined)) {
      parsed.push(
        answer
          ? { questionId, question, answer }
          : { questionId, question, answer: "", declined: true },
      );
    }
  }
  return parsed;
}

export function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Everything the analyst has told this analysis, across every round.
 *
 * The screen submits only the answers on it. That is right for the screen —
 * it is showing the questions this round raised — but it made the request
 * body a *replacement* for the record rather than an addition to it. A run
 * that asked about material, got an answer, then came back asking about end
 * use had the material answer overwritten by the end-use one, in the stored
 * record and in what was passed to the model. So the second round classified
 * without a fact the first round had established, the determination printed
 * a refinement list missing it, and the analyst saw only that they had been
 * asked something new.
 *
 * Later answers win, because re-answering is how a correction is made. A
 * question counts as the same one when its id *and* its text match: ids come
 * from the model and are not guaranteed stable across rounds, and keeping two
 * entries for what may be one question is a smaller failure than dropping an
 * answer to what is certainly two.
 */
export function mergeRefinements(
  prior: Refinement[],
  incoming: Refinement[],
): Refinement[] {
  const key = (refinement: Refinement) =>
    `${refinement.questionId}\u0000${refinement.question}`;
  const merged = new Map(prior.map((refinement) => [key(refinement), refinement]));
  for (const refinement of incoming) merged.set(key(refinement), refinement);
  return [...merged.values()];
}
