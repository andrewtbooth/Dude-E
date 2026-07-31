import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupFixtureIndex, teardownFixtureIndex } from "../../test/htsus-fixture";
import { verifyAgainstTariff } from "./classify";
import type { Candidate, ClassificationResult } from "./schema";

beforeAll(() => setupFixtureIndex());
afterAll(() => teardownFixtureIndex());

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    rank: 1,
    hts_code: "8507.60.00.20",
    description_path: ["Electric storage batteries", "Lithium-ion", "Other"],
    confidence: 0.8,
    gri_analysis: {
      gri_1: "Heading 8507 covers electric storage batteries eo nomine.",
      gri_2: null,
      gri_3: null,
      gri_4: null,
      gri_5: null,
      gri_6: "Not of a kind used as primary power for EVs, so the residual applies.",
      additional_us_rules: null,
    },
    notes_applied: [],
    justification: "A lithium-ion cell is provided for by name in 8507.60.",
    duty: {
      general: "3.4%",
      special: "",
      column_2: "35%",
      rates_published_on: null,
    },
    unit_of_quantity: ["No."],
    chapter_99: [],
    schedule_b: [],
    cross_rulings: [],
    why_not_selected: null,
    ...overrides,
  };
}

function result(candidates: Candidate[]): ClassificationResult {
  return {
    status: "complete",
    htsus_revision: "2026 HTS Revision 13",
    summary: "Summary.",
    researched_product: null,
    clarifying_questions: [],
    candidates,
    recommended_hts_code: candidates[0]?.hts_code ?? null,
    assumptions: [],
    info_that_would_raise_confidence: [],
  };
}

describe("verifyAgainstTariff", () => {
  it("keeps a code that exists and is declarable", () => {
    const { result: verified, verification } = verifyAgainstTariff(
      result([candidate()]),
    );

    expect(verification.verifiedCodes).toEqual(["8507.60.00.20"]);
    expect(verification.rejectedCodes).toEqual([]);
    expect(verified.candidates).toHaveLength(1);
  });

  it("drops a fabricated code", () => {
    // The headline guardrail: a well-formed but nonexistent 10-digit number is
    // the most damaging thing this system could emit.
    const { result: verified, verification } = verifyAgainstTariff(
      result([candidate({ hts_code: "8507.60.00.99" })]),
    );

    expect(verified.candidates).toHaveLength(0);
    expect(verification.rejectedCodes).toEqual([
      { code: "8507.60.00.99", reason: "not present in this HTSUS revision" },
    ]);
  });

  it("drops a code that is real but not declarable", () => {
    // 8-digit rate lines exist, but you cannot put one on an entry.
    const { verification } = verifyAgainstTariff(
      result([candidate({ hts_code: "8507.60.00" })]),
    );

    expect(verification.verifiedCodes).toEqual([]);
    expect(verification.rejectedCodes[0].reason).toMatch(
      /8-digit line, which cannot be declared/,
    );
  });

  it("overwrites duty rates with the tariff's own values", () => {
    const { result: verified } = verifyAgainstTariff(
      result([
        candidate({
          duty: {
            general: "2.7%", // model mis-transcribed
            special: "wrong",
            column_2: "wrong",
            rates_published_on: null,
          },
        }),
      ]),
    );

    expect(verified.candidates[0].duty.general).toBe("3.4%");
    expect(verified.candidates[0].duty.column_2).toBe("35%");
    // Inherited rates keep their provenance so the PDF can say so.
    expect(verified.candidates[0].duty.rates_published_on).toBe("8507.60.00");
  });

  it("records the disagreement when it corrects a rate", () => {
    const { verification } = verifyAgainstTariff(
      result([
        candidate({
          duty: {
            general: "2.7%",
            special: "",
            column_2: "35%",
            rates_published_on: null,
          },
        }),
      ]),
    );

    const dutyCorrection = verification.corrections.find(
      (c) => c.field === "duty.general",
    );
    expect(dutyCorrection).toEqual({
      htsCode: "8507.60.00.20",
      field: "duty.general",
      modelValue: "2.7%",
      indexValue: "3.4%",
    });
  });

  it("replaces the description path with the tariff's", () => {
    const { result: verified } = verifyAgainstTariff(
      result([candidate({ description_path: ["Wrong", "Path"] })]),
    );

    expect(verified.candidates[0].description_path).toEqual([
      "Electric storage batteries, including separators therefor; parts thereof:",
      "Lithium-ion batteries:",
      "Other",
      "Other",
    ]);
  });

  it("replaces units with the tariff's", () => {
    const { result: verified } = verifyAgainstTariff(
      result([candidate({ unit_of_quantity: ["kg only"] })]),
    );
    expect(verified.candidates[0].unit_of_quantity).toEqual(["No.", "kg"]);
  });

  it("re-ranks contiguously after a drop", () => {
    const { result: verified } = verifyAgainstTariff(
      result([
        candidate({ rank: 1, hts_code: "0000.00.00.00" }), // fabricated
        candidate({ rank: 2, hts_code: "9617.00.10.00", why_not_selected: "b" }),
        candidate({ rank: 3, hts_code: "7323.93.00.80", why_not_selected: "c" }),
      ]),
    );

    expect(verified.candidates.map((c) => c.rank)).toEqual([1, 2]);
    expect(verified.candidates.map((c) => c.hts_code)).toEqual([
      "9617.00.10.00",
      "7323.93.00.80",
    ]);
  });

  it("clears why_not_selected on whatever becomes rank 1", () => {
    const { result: verified } = verifyAgainstTariff(
      result([
        candidate({ rank: 1, hts_code: "0000.00.00.00" }),
        candidate({ rank: 2, hts_code: "9617.00.10.00", why_not_selected: "loses on GRI 3(b)" }),
      ]),
    );

    expect(verified.candidates[0].why_not_selected).toBeNull();
  });

  it("promotes the recommendation when the recommended code was dropped", () => {
    const base = result([
      candidate({ rank: 1, hts_code: "0000.00.00.00" }),
      candidate({ rank: 2, hts_code: "9617.00.10.00" }),
    ]);
    base.recommended_hts_code = "0000.00.00.00";

    const { result: verified } = verifyAgainstTariff(base);
    expect(verified.recommended_hts_code).toBe("9617.00.10.00");
  });

  it("keeps the recommendation when it survives, even if not listed first", () => {
    const base = result([
      candidate({ rank: 1, hts_code: "9617.00.10.00" }),
      candidate({ rank: 2, hts_code: "7323.93.00.80" }),
    ]);
    base.recommended_hts_code = "7323.93.00.80";

    const { result: verified } = verifyAgainstTariff(base);
    expect(verified.recommended_hts_code).toBe("7323.93.00.80");
  });

  it("normalises an undotted recommendation to the tariff's formatting", () => {
    const base = result([candidate({ hts_code: "8507600020" })]);
    base.recommended_hts_code = "8507600020";

    const { result: verified } = verifyAgainstTariff(base);
    expect(verified.candidates[0].hts_code).toBe("8507.60.00.20");
    expect(verified.recommended_hts_code).toBe("8507.60.00.20");
  });

  it("returns no recommendation when every candidate was dropped", () => {
    const { result: verified } = verifyAgainstTariff(
      result([candidate({ hts_code: "0000.00.00.00" })]),
    );
    expect(verified.candidates).toEqual([]);
    expect(verified.recommended_hts_code).toBeNull();
  });
});
