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
  /** Answers to supply if the model asks clarifying questions. */
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
