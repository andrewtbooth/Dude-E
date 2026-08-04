import type { ClassificationRun } from "../agent/classify";
import type { Candidate, Refinement } from "../agent/schema";
import type { DeterminationView } from "./types";

/** How many rejected alternates the determination carries. */
export const MAX_ALTERNATES = 5;

export function parseRun(resultJson: string): ClassificationRun {
  return JSON.parse(resultJson) as ClassificationRun;
}

export function parseRefinements(json: string): Refinement[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Refinement[]) : [];
  } catch {
    return [];
  }
}

export function findCandidate(
  candidates: Candidate[],
  htsCode: string,
): Candidate | null {
  const target = htsCode.replace(/\D/g, "");
  return (
    candidates.find(
      (candidate) => candidate.hts_code.replace(/\D/g, "") === target,
    ) ?? null
  );
}

/**
 * The alternates that appear in the exported determination: the next-best
 * candidates, excluding whichever one the analyst selected.
 *
 * Note this is not simply "ranks 2 and below" — if the analyst overrode the
 * model and picked rank 3, then rank 1 becomes an alternate, and the
 * determination should show why it was passed over.
 */
export function selectAlternates(
  candidates: Candidate[],
  selectedHtsCode: string,
): Candidate[] {
  const target = selectedHtsCode.replace(/\D/g, "");
  return candidates
    .filter((candidate) => candidate.hts_code.replace(/\D/g, "") !== target)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_ALTERNATES);
}

export interface BuildViewInput {
  determinationId: string;
  analyst: { name: string; email: string };
  decidedAt: Date;
  htsusRevision: string;
  /** Schedule B edition year, or null when none was synced. */
  scheduleBEdition: string | null;
  /** When the tariff snapshot was pulled, for dating Chapter 99 duties. */
  tariffRetrievedAt: Date | null;
  model: string;
  effort: string;
  appVersion: string;
  analystNote: string | null;
  mode: "PART_NUMBER" | "DESCRIPTION";
  input: string;
  refinements: Refinement[];
  run: ClassificationRun;
  selected: Candidate;
  alternates: Candidate[];
}

export function buildDeterminationView(
  input: BuildViewInput,
): DeterminationView {
  const modelRecommendation = input.run.result.recommended_hts_code;
  const overrode =
    modelRecommendation !== null &&
    modelRecommendation.replace(/\D/g, "") !==
      input.selected.hts_code.replace(/\D/g, "");

  return {
    id: input.determinationId,
    analyst: input.analyst,
    decidedAt: input.decidedAt,
    htsusRevision: input.htsusRevision,
    scheduleBEdition: input.scheduleBEdition,
    tariffRetrievedAt: input.tariffRetrievedAt,
    verification: {
      rejectedCodes: input.run.verification.rejectedCodes,
      corrections: input.run.verification.corrections,
    },
    model: input.model,
    effort: input.effort,
    appVersion: input.appVersion,
    subject: {
      mode: input.mode,
      input: input.input,
      researched: input.run.result.researched_product,
      refinements: input.refinements.map((refinement) => ({
        question: refinement.question,
        answer: refinement.answer,
      })),
    },
    selected: input.selected,
    alternates: input.alternates,
    assumptions: input.run.result.assumptions,
    analystNote: input.analystNote,
    overrodeRecommendation: overrode,
    modelRecommendation,
  };
}
