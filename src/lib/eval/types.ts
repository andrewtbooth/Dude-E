/**
 * Types for the classification eval harness.
 *
 * The README recommends sweeping `CLASSIFIER_EFFORT` against "your own accuracy
 * bar" — and until now the repo shipped no way to measure one. Confidence
 * scores were uncalibrated self-reports with nothing checking them, which meant
 * an analyst had no basis for knowing whether 0.85 meant anything at all.
 */

/** Where a case's expected answer comes from. Provenance matters here too. */
export type EvalSource =
  /** CBP ruled on this good. The only true ground truth. */
  | "cbp_ruling"
  /** An analyst on the team classified it and stands behind it. */
  | "analyst"
  /**
   * Constructed from the tariff's own eo nomine wording — the good is named in
   * the schedule, so the answer is not contestable. These check that retrieval
   * and the GRI machinery work; they do NOT measure judgement on hard goods,
   * and a harness scoring well on these alone has proved very little.
   */
  | "eo_nomine";

export interface EvalCase {
  /** Stable identifier, e.g. "flask-1l". */
  id: string;
  mode: "DESCRIPTION" | "PART_NUMBER";
  /** Exactly what an analyst would type. */
  input: string;
  /** The correct 10-digit code, dotted. */
  expected: string;
  source: EvalSource;
  /** For `cbp_ruling`, the ruling number, so the claim can be checked. */
  citation?: string;
  /** Why this case is worth having — the tension it exercises. */
  note?: string;
  /**
   * What this case is testing, for slicing the report.
   *
   * A blended accuracy figure over a mixed case set is close to meaningless
   * here, because the difficulty range is enormous: a laptop named almost
   * verbatim in the schedule and a composite article turning on essential
   * character are not the same measurement, and averaging them lets the easy
   * cases carry the hard ones. Tags are how "82% overall" becomes "97% on eo
   * nomine, 54% on GRI 3(b)", which is the sentence someone can act on.
   *
   * Free-form on purpose — the tensions worth tracking are the ones your own
   * catalogue actually contains. `eval/README.md` lists the ones in use.
   */
  tags?: string[];
  /**
   * Answers to supply if the model asks clarifying questions.
   *
   * A case with none is also a test: it measures what the tool does with an
   * under-specified description, which is most of what an analyst types.
   */
  refinements?: { question: string; answer: string }[];
}

export interface EvalOutcome {
  caseId: string;
  expected: string;
  /** What the analyst would have been shown as rank 1. Null if the run failed. */
  predicted: string | null;
  /** Every candidate returned, in rank order. */
  candidates: { code: string; confidence: number }[];
  /** Model confidence in the rank-1 candidate. */
  confidence: number | null;
  status: "complete" | "needs_more_info" | "failed";
  error?: string;
  /** Codes the tariff check discarded — a direct signal the run went wrong. */
  rejectedCodes: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}
