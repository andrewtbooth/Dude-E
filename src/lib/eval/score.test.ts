import { describe, expect, it } from "vitest";
import { parseCases, describeProvenance } from "./cases";
import { matchLevel, rankOfExpected, scoreEval } from "./score";
import type { EvalCase, EvalOutcome } from "./types";

function outcome(overrides: Partial<EvalOutcome> = {}): EvalOutcome {
  return {
    caseId: "a",
    expected: "8507.60.00.20",
    predicted: "8507.60.00.20",
    candidates: [{ code: "8507.60.00.20", confidence: 0.9 }],
    confidence: 0.9,
    status: "complete",
    rejectedCodes: 0,
    durationMs: 1000,
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

function evalCase(id: string, expected = "8507.60.00.20"): EvalCase {
  return { id, mode: "DESCRIPTION", input: "x", expected, source: "eo_nomine" };
}

describe("matchLevel", () => {
  it("scores depth of agreement, not just right or wrong", () => {
    // The distinction that matters: correct to 8 digits means the duty rate on
    // the entry is right and only the statistical suffix is wrong.
    expect(matchLevel("8507.60.00.20", "8507.60.00.20")).toBe("exact");
    expect(matchLevel("8507.60.00.20", "8507.60.00.10")).toBe("rate_line");
    expect(matchLevel("8507.60.00.20", "8507.60.90.00")).toBe("subheading");
    expect(matchLevel("8507.60.00.20", "8548.00.00.00")).toBe("chapter");
    expect(matchLevel("8507.60.00.20", "9617.00.10.00")).toBe("none");
  });

  it("compares on digits, so formatting never changes the score", () => {
    expect(matchLevel("8507.60.00.20", "8507600020")).toBe("exact");
  });

  it("treats a missing prediction as no match", () => {
    expect(matchLevel("8507.60.00.20", null)).toBe("none");
    expect(matchLevel("8507.60.00.20", "")).toBe("none");
  });
});

describe("rankOfExpected", () => {
  it("finds the expected code below rank 1", () => {
    expect(
      rankOfExpected(
        outcome({
          predicted: "8507.60.00.10",
          candidates: [
            { code: "8507.60.00.10", confidence: 0.6 },
            { code: "8507.60.00.20", confidence: 0.3 },
          ],
        }),
      ),
    ).toBe(2);
  });

  it("returns 0 when the expected code was never offered", () => {
    expect(
      rankOfExpected(
        outcome({ predicted: "9617.00.10.00", candidates: [{ code: "9617.00.10.00", confidence: 0.8 }] }),
      ),
    ).toBe(0);
  });
});

describe("scoreEval", () => {
  it("counts depth cumulatively, so an exact hit also counts as rate-line", () => {
    const report = scoreEval(
      [evalCase("a")],
      [outcome()],
    );
    expect(report.exact).toBe(1);
    expect(report.toRateLine).toBe(1);
    expect(report.toSubheading).toBe(1);
    expect(report.toChapter).toBe(1);
  });

  it("separates a suffix miss from a real miss", () => {
    const report = scoreEval(
      [evalCase("a"), evalCase("b")],
      [
        outcome({ caseId: "a", predicted: "8507.60.00.10" }),
        outcome({ caseId: "b", predicted: "9617.00.10.00" }),
      ],
    );
    expect(report.exact).toBe(0);
    expect(report.toRateLine).toBe(1);
    expect(report.toChapter).toBe(1);
  });

  it("measures whether the right answer was offered at all", () => {
    // A model that ranks the right code second is a very different problem
    // from one that never surfaces it — the first is a re-ranking fix.
    const report = scoreEval(
      [evalCase("a")],
      [
        outcome({
          predicted: "8507.60.00.10",
          candidates: [
            { code: "8507.60.00.10", confidence: 0.7 },
            { code: "8507.60.00.20", confidence: 0.4 },
          ],
        }),
      ],
    );
    expect(report.recallAnyRank).toBe(1);
    expect(report.meanRankWhenFound).toBe(2);
  });

  it("counts runs where the tariff check discarded a code", () => {
    const report = scoreEval([evalCase("a")], [outcome({ rejectedCodes: 2 })]);
    expect(report.runsWithRejectedCodes).toBe(1);
  });

  it("counts failures and unanswered runs without scoring them as wrong guesses", () => {
    const report = scoreEval(
      [evalCase("a"), evalCase("b")],
      [
        outcome({ caseId: "a", status: "failed", predicted: null, confidence: null }),
        outcome({ caseId: "b", status: "needs_more_info" }),
      ],
    );
    expect(report.failed).toBe(1);
    expect(report.needsMoreInfo).toBe(1);
    // Neither committed to an answer, so neither belongs in calibration.
    expect(report.calibration.buckets.every((b) => b.count === 0)).toBe(true);
    expect(report.calibration.ece).toBeNull();
  });

  it("ignores outcomes for cases that are not in the set", () => {
    const report = scoreEval([evalCase("a")], [outcome({ caseId: "ghost" })]);
    expect(report.scored).toBe(0);
  });
});

describe("calibration", () => {
  it("reports stated confidence against observed accuracy per band", () => {
    const cases = ["a", "b", "c", "d"].map((id) => evalCase(id));
    const report = scoreEval(cases, [
      outcome({ caseId: "a", confidence: 0.95 }),
      outcome({ caseId: "b", confidence: 0.95, predicted: "9617.00.10.00" }),
      outcome({ caseId: "c", confidence: 0.6 }),
      outcome({ caseId: "d", confidence: 0.6, predicted: "9617.00.10.00" }),
    ]);

    const top = report.calibration.buckets.find((b) => b.from === 0.9);
    expect(top?.count).toBe(2);
    expect(top?.accuracy).toBe(0.5);
    // Claiming 95% while being right half the time is exactly the miscalibration
    // this measurement exists to expose.
    expect(top?.meanConfidence).toBeCloseTo(0.95, 5);
  });

  it("counts the confidently wrong separately", () => {
    // The prompt reserves >0.9 for classifications defensible unaided, so a
    // wrong answer there is a case where the analyst was told not to look.
    const report = scoreEval(
      [evalCase("a"), evalCase("b")],
      [
        outcome({ caseId: "a", confidence: 0.97, predicted: "9617.00.10.00" }),
        outcome({ caseId: "b", confidence: 0.4, predicted: "9617.00.10.00" }),
      ],
    );
    expect(report.calibration.confidentlyWrong).toBe(1);
  });

  it("scores a perfectly calibrated set at zero error", () => {
    const report = scoreEval(
      [evalCase("a"), evalCase("b")],
      [
        outcome({ caseId: "a", confidence: 1 }),
        outcome({ caseId: "b", confidence: 0, predicted: "9617.00.10.00" }),
      ],
    );
    expect(report.calibration.ece).toBeCloseTo(0, 5);
    expect(report.calibration.brier).toBeCloseTo(0, 5);
  });
});

describe("parseCases", () => {
  it("reads a well-formed case", () => {
    const { cases, problems } = parseCases(
      JSON.stringify({
        id: "flask",
        input: "vacuum flask",
        expected: "9617.00.10.00",
        source: "eo_nomine",
      }),
    );
    expect(problems).toEqual([]);
    expect(cases[0].id).toBe("flask");
    expect(cases[0].mode).toBe("DESCRIPTION");
  });

  it("rejects an expected code that is not 10 digits", () => {
    // An 8-digit line cannot be declared on an entry, so it cannot be a
    // correct answer and would silently score every run as a miss.
    const { cases, problems } = parseCases(
      JSON.stringify({ id: "x", input: "y", expected: "9617.00.10", source: "eo_nomine" }),
    );
    expect(cases).toEqual([]);
    expect(problems[0]).toMatch(/10-digit/);
  });

  it("requires a citation when a case claims CBP ruled on it", () => {
    // The strongest claim a case can make has to be checkable.
    const { problems } = parseCases(
      JSON.stringify({
        id: "x",
        input: "y",
        expected: "9617.00.10.00",
        source: "cbp_ruling",
      }),
    );
    expect(problems[0]).toMatch(/requires a "citation"/);
  });

  it("reports malformed lines rather than skipping them silently", () => {
    const { cases, problems } = parseCases("{not json}\n");
    expect(cases).toEqual([]);
    expect(problems[0]).toMatch(/not valid JSON/);
  });

  it("rejects duplicate ids", () => {
    const row = JSON.stringify({
      id: "dup",
      input: "y",
      expected: "9617.00.10.00",
      source: "eo_nomine",
    });
    const { cases, problems } = parseCases(`${row}\n${row}`);
    expect(cases).toHaveLength(1);
    expect(problems[0]).toMatch(/duplicate id/);
  });

  it("skips blank lines and comments", () => {
    const { cases, problems } = parseCases(
      `// a note\n\n${JSON.stringify({ id: "a", input: "y", expected: "9617.00.10.00", source: "eo_nomine" })}\n`,
    );
    expect(problems).toEqual([]);
    expect(cases).toHaveLength(1);
  });
});

describe("describeProvenance", () => {
  it("warns plainly when nothing in the set is real ground truth", () => {
    const text = describeProvenance([evalCase("a"), evalCase("b")]);
    expect(text).toContain("NOT judgement on contestable goods");
  });

  it("acknowledges cases that carry real ground truth", () => {
    const text = describeProvenance([
      { ...evalCase("a"), source: "cbp_ruling", citation: "N301234" },
      evalCase("b"),
    ]);
    expect(text).toContain("1 case(s) carry real ground truth");
  });
});
