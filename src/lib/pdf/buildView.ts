import { backfillRunFields, type ClassificationRun } from "../agent/classify";
import type { Candidate, Refinement } from "../agent/schema";
import { sameHtsCode } from "../hts/parse";
import type { Chapter99ScreeningScope } from "../hts/store";
import type { DeterminationView } from "./types";

/** How many rejected alternates the determination carries. */
export const MAX_ALTERNATES = 5;

/**
 * Rehydrate a run that was stored verbatim at analysis time.
 *
 * The cast is deliberate — runs are stored as returned so a determination can
 * be reconstructed even after the schema moves — but it means the type
 * describes what the *current* classifier emits, not what is necessarily in
 * the row, so fields added since a row was written need filling in.
 */
export function parseRun(resultJson: string): ClassificationRun {
  return backfillRunFields(JSON.parse(resultJson) as ClassificationRun);
}

/**
 * The same, for a row that may not have a readable result.
 *
 * A saved analysis is shown around its result, not because of it: the
 * provenance and the offer to run again are worth rendering when the JSON is
 * unreadable, and "no result was stored" is a more useful answer than a 500.
 *
 * Backfilled like every other read. The saved page had its own parse that was
 * not, so it was the one view in the app reading a run raw — every field added
 * since a row was written was present on the live page and the document and
 * missing there, held up only by defensive checks downstream.
 */
export function parseStoredRun(
  resultJson: string | null,
): ClassificationRun | null {
  if (!resultJson) return null;
  try {
    return parseRun(resultJson);
  } catch {
    return null;
  }
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
  return (
    candidates.find((candidate) => sameHtsCode(candidate.hts_code, htsCode)) ??
    null
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
  return candidates
    .filter((candidate) => !sameHtsCode(candidate.hts_code, selectedHtsCode))
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
  chapter99Scope?: Chapter99ScreeningScope | null;
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
    !sameHtsCode(modelRecommendation, input.selected.hts_code);

  return {
    id: input.determinationId,
    analyst: input.analyst,
    decidedAt: input.decidedAt,
    htsusRevision: input.htsusRevision,
    scheduleBEdition: input.scheduleBEdition,
    tariffRetrievedAt: input.tariffRetrievedAt,
    chapter99Scope: input.chapter99Scope ?? null,
    verification: {
      verifiedCodes: input.run.verification.verifiedCodes,
      rejectedCodes: input.run.verification.rejectedCodes,
      corrections: input.run.verification.corrections,
      substitutedRecommendation:
        input.run.verification.substitutedRecommendation ?? null,
      reportingNumberNotes: input.run.verification.reportingNumberNotes ?? [],
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
        declined: refinement.declined,
      })),
    },
    selected: input.selected,
    alternates: input.alternates,
    alternatesConsidered: input.run.result.candidates.filter(
      (candidate) => !sameHtsCode(candidate.hts_code, input.selected.hts_code),
    ).length,
    assumptions: input.run.result.assumptions,
    analystNote: input.analystNote,
    overrodeRecommendation: overrode,
    modelRecommendation,
  };
}
