/**
 * Scoring for the eval harness.
 *
 * Kept pure and separate from the runner so the harness can be tested without
 * spending API budget: everything here is arithmetic over recorded outcomes.
 *
 * ## Why not just "percent correct"
 *
 * A single accuracy number hides the two things that actually matter for this
 * tool.
 *
 * **Being wrong at different depths has different consequences.** A 10-digit
 * miss inside the right 8-digit rate line means the duty rate on the entry is
 * still right and the statistical suffix is wrong — a reporting error. A miss
 * at the chapter level means the analysis went somewhere else entirely. Both
 * count as "incorrect" and they are not the same failure, so accuracy is
 * reported at each level of the schedule.
 *
 * **Calibration matters as much as accuracy.** An analyst's only defence
 * against a fluent wrong answer is the confidence number telling them to look
 * harder. A model that is 70% accurate and knows it is far more useful than one
 * that is 80% accurate and claims 95% throughout. So the harness measures
 * whether stated confidence tracks observed correctness, and separately counts
 * the confidently-wrong, which is the population that actually causes damage.
 */

import type { EvalCase, EvalOutcome } from "./types";

/** Bare digits, so "8507.60.00.20" and "8507600020" compare equal. */
function digits(code: string): string {
  return code.replace(/\D/g, "");
}

export type MatchLevel = "exact" | "rate_line" | "subheading" | "chapter" | "none";

/**
 * How deep the prediction agreed with the expected code.
 *
 * `rate_line` (8 digits) is called out because that is where duty is set: a
 * prediction correct to 8 digits produces the right duty and the wrong
 * statistical suffix.
 */
export function matchLevel(expected: string, predicted: string | null): MatchLevel {
  if (!predicted) return "none";
  const want = digits(expected);
  const got = digits(predicted);
  if (want.length === 0 || got.length === 0) return "none";
  if (want === got) return "exact";
  if (want.slice(0, 8) === got.slice(0, 8)) return "rate_line";
  if (want.slice(0, 6) === got.slice(0, 6)) return "subheading";
  if (want.slice(0, 2) === got.slice(0, 2)) return "chapter";
  return "none";
}

/** Ranks are 1-based; 0 means the expected code was not offered at all. */
export function rankOfExpected(outcome: EvalOutcome): number {
  const want = digits(outcome.expected);
  const index = outcome.candidates.findIndex((c) => digits(c.code) === want);
  return index === -1 ? 0 : index + 1;
}

export interface CalibrationBucket {
  /** Inclusive lower bound of the confidence band, e.g. 0.8. */
  from: number;
  /** Exclusive upper bound, except the last band which includes 1. */
  to: number;
  count: number;
  correct: number;
  /** Mean stated confidence in this band. */
  meanConfidence: number;
  /** Observed accuracy in this band. */
  accuracy: number;
}

export interface EvalReport {
  cases: number;
  scored: number;
  failed: number;
  needsMoreInfo: number;

  /** Rank-1 prediction exactly equals the expected 10-digit code. */
  exact: number;
  /** Correct to the 8-digit rate line — right duty, wrong suffix. */
  toRateLine: number;
  toSubheading: number;
  toChapter: number;

  /** Expected code appeared anywhere in the candidate list. */
  recallAnyRank: number;
  /** Mean rank of the expected code, over cases where it appeared. */
  meanRankWhenFound: number | null;

  /** Runs where the tariff check discarded at least one code. */
  runsWithRejectedCodes: number;

  calibration: {
    buckets: CalibrationBucket[];
    /** Expected Calibration Error: mean |confidence − accuracy|, weighted. */
    ece: number | null;
    /** Brier score over exact-match outcomes. Lower is better; 0 is perfect. */
    brier: number | null;
    /**
     * Wrong answers stated above 0.9. The prompt reserves that band for
     * classifications defensible to CBP unaided, so anything here is a case
     * where the analyst was told not to look and should have.
     */
    confidentlyWrong: number;
  };

  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;

  /** Per-case detail, for reading the failures rather than just counting them. */
  rows: {
    caseId: string;
    expected: string;
    predicted: string | null;
    level: MatchLevel;
    confidence: number | null;
    rankOfExpected: number;
    status: EvalOutcome["status"];
  }[];
}

const BANDS: [number, number][] = [
  [0, 0.5],
  [0.5, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1.0001],
];

export function scoreEval(
  cases: readonly EvalCase[],
  outcomes: readonly EvalOutcome[],
): EvalReport {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const rows: EvalReport["rows"] = [];

  let exact = 0;
  let toRateLine = 0;
  let toSubheading = 0;
  let toChapter = 0;
  let failed = 0;
  let needsMoreInfo = 0;
  let recallAnyRank = 0;
  let runsWithRejectedCodes = 0;
  let rankSum = 0;
  let rankCount = 0;

  const graded: { confidence: number; correct: boolean }[] = [];

  for (const outcome of outcomes) {
    if (!byId.has(outcome.caseId)) continue;

    const level = matchLevel(outcome.expected, outcome.predicted);
    const rank = rankOfExpected(outcome);

    if (outcome.status === "failed") failed += 1;
    if (outcome.status === "needs_more_info") needsMoreInfo += 1;
    if (outcome.rejectedCodes > 0) runsWithRejectedCodes += 1;

    // Cumulative: an exact match is also correct to the rate line and above.
    if (level === "exact") exact += 1;
    if (level === "exact" || level === "rate_line") toRateLine += 1;
    if (level === "exact" || level === "rate_line" || level === "subheading") {
      toSubheading += 1;
    }
    if (level !== "none") toChapter += 1;

    if (rank > 0) {
      recallAnyRank += 1;
      rankSum += rank;
      rankCount += 1;
    }

    // Calibration is only meaningful where the model committed to an answer.
    if (outcome.status === "complete" && outcome.confidence !== null) {
      graded.push({
        confidence: clamp01(outcome.confidence),
        correct: level === "exact",
      });
    }

    rows.push({
      caseId: outcome.caseId,
      expected: outcome.expected,
      predicted: outcome.predicted,
      level,
      confidence: outcome.confidence,
      rankOfExpected: rank,
      status: outcome.status,
    });
  }

  return {
    cases: cases.length,
    scored: rows.length,
    failed,
    needsMoreInfo,
    exact,
    toRateLine,
    toSubheading,
    toChapter,
    recallAnyRank,
    meanRankWhenFound: rankCount === 0 ? null : rankSum / rankCount,
    runsWithRejectedCodes,
    calibration: calibrate(graded),
    totalDurationMs: sum(outcomes.map((o) => o.durationMs)),
    totalInputTokens: sum(outcomes.map((o) => o.inputTokens)),
    totalOutputTokens: sum(outcomes.map((o) => o.outputTokens)),
    rows,
  };
}

function calibrate(
  graded: readonly { confidence: number; correct: boolean }[],
): EvalReport["calibration"] {
  const buckets: CalibrationBucket[] = BANDS.map(([from, to]) => {
    const inBand = graded.filter((g) => g.confidence >= from && g.confidence < to);
    const correct = inBand.filter((g) => g.correct).length;
    return {
      from,
      to: to > 1 ? 1 : to,
      count: inBand.length,
      correct,
      meanConfidence:
        inBand.length === 0 ? 0 : sum(inBand.map((g) => g.confidence)) / inBand.length,
      accuracy: inBand.length === 0 ? 0 : correct / inBand.length,
    };
  });

  if (graded.length === 0) {
    return { buckets, ece: null, brier: null, confidentlyWrong: 0 };
  }

  const ece =
    sum(
      buckets
        .filter((b) => b.count > 0)
        .map((b) => (b.count / graded.length) * Math.abs(b.meanConfidence - b.accuracy)),
    ) || 0;

  const brier =
    sum(graded.map((g) => (g.confidence - (g.correct ? 1 : 0)) ** 2)) / graded.length;

  const confidentlyWrong = graded.filter((g) => !g.correct && g.confidence > 0.9).length;

  return { buckets, ece, brier, confidentlyWrong };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** Human-readable report, written to stdout and to the run's output file. */
export function formatReport(report: EvalReport, label: string): string {
  const pct = (n: number) =>
    report.scored === 0 ? "  n/a" : `${((n / report.scored) * 100).toFixed(1)}%`;

  const lines: string[] = [];
  lines.push(`Classification eval — ${label}`);
  lines.push("");
  lines.push(`  cases scored:        ${report.scored} of ${report.cases}`);
  lines.push(`  failed runs:         ${report.failed}`);
  lines.push(`  needs_more_info:     ${report.needsMoreInfo}`);
  lines.push("");
  lines.push("Accuracy of the rank-1 candidate, by depth of agreement:");
  const row = (label: string, n: number, tail = "") =>
    `  ${label.padEnd(22)}${String(n).padStart(4)} (${pct(n)})${tail}`;
  lines.push(row("exact 10-digit", report.exact));
  lines.push(row("to 8-digit rate line", report.toRateLine, "   <- duty correct"));
  lines.push(row("to 6-digit HS", report.toSubheading));
  lines.push(row("to chapter", report.toChapter));
  lines.push("");
  lines.push(`  expected code offered at any rank: ${report.recallAnyRank} (${pct(report.recallAnyRank)})`);
  if (report.meanRankWhenFound !== null) {
    lines.push(`  mean rank when offered:            ${report.meanRankWhenFound.toFixed(2)}`);
  }
  lines.push(`  runs where the tariff check discarded a code: ${report.runsWithRejectedCodes}`);
  lines.push("");
  lines.push("Calibration — does stated confidence track being right?");
  for (const b of report.calibration.buckets) {
    if (b.count === 0) continue;
    lines.push(
      `  ${b.from.toFixed(2)}-${b.to.toFixed(2)}  n=${String(b.count).padStart(3)}  ` +
        `stated ${(b.meanConfidence * 100).toFixed(0)}%  actual ${(b.accuracy * 100).toFixed(0)}%`,
    );
  }
  if (report.calibration.ece !== null) {
    lines.push(`  expected calibration error: ${(report.calibration.ece * 100).toFixed(1)}%`);
  }
  if (report.calibration.brier !== null) {
    lines.push(`  Brier score:                ${report.calibration.brier.toFixed(3)}`);
  }
  lines.push(
    `  wrong while above 0.9:      ${report.calibration.confidentlyWrong}` +
      (report.calibration.confidentlyWrong > 0
        ? "   <- the population that causes damage"
        : ""),
  );
  lines.push("");
  lines.push(
    `  wall clock: ${(report.totalDurationMs / 1000).toFixed(0)}s   ` +
      `tokens in/out: ${report.totalInputTokens}/${report.totalOutputTokens}`,
  );

  const misses = report.rows.filter((r) => r.level !== "exact");
  if (misses.length > 0) {
    lines.push("");
    lines.push("Cases not matched exactly:");
    for (const row of misses) {
      lines.push(
        `  ${row.caseId.padEnd(22)} expected ${row.expected}  got ${row.predicted ?? "(none)"}  ` +
          `[${row.level}]` +
          (row.confidence === null ? "" : ` conf ${(row.confidence * 100).toFixed(0)}%`) +
          (row.rankOfExpected > 0 ? ` (expected was rank ${row.rankOfExpected})` : ""),
      );
    }
  }

  return lines.join("\n");
}
