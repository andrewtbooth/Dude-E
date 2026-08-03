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
    schedule_b: null,
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

describe("verifyAgainstTariff — Schedule B", () => {
  const scheduleB = (overrides: Partial<NonNullable<Candidate["schedule_b"]>> = {}) => ({
    code: "9617.00.20.00",
    description: "FLASK AND OTHER VESSELS, COMPLETE WITH CASES",
    unit_of_quantity: ["NO"],
    justification: "Complete vessel, not a part.",
    considered: [],
    ...overrides,
  });

  it("drops an export code that does not exist in the schedule", () => {
    // The same failure mode as a fabricated HTS number, and it lands on the
    // EEI rather than the entry — so it gets the same treatment.
    const { result: verified, verification } = verifyAgainstTariff(
      result([
        candidate({
          hts_code: "9617.00.10.00",
          schedule_b: scheduleB({ code: "9617.00.99.00" }),
        }),
      ]),
    );

    expect(verified.candidates[0].schedule_b).toBeNull();
    expect(verification.rejectedCodes).toContainEqual({
      code: "9617.00.99.00",
      reason:
        "Schedule B code not present in this edition of the export schedule",
    });
    // The candidate itself survives — only its export code was unverifiable.
    expect(verified.candidates).toHaveLength(1);
  });

  it("lets the schedule overwrite the description and units", () => {
    const { result: verified, verification } = verifyAgainstTariff(
      result([
        candidate({
          hts_code: "9617.00.10.00",
          schedule_b: scheduleB({
            description: "Vacuum flasks, complete",
            unit_of_quantity: ["No.", "kg"],
          }),
        }),
      ]),
    );

    expect(verified.candidates[0].schedule_b).toMatchObject({
      description: "FLASK AND OTHER VESSELS, COMPLETE WITH CASES",
      unit_of_quantity: ["NO"],
      justification: "Complete vessel, not a part.",
    });
    expect(verification.corrections).toContainEqual({
      htsCode: "9617.00.10.00",
      field: "schedule_b.description",
      modelValue: "Vacuum flasks, complete",
      indexValue: "FLASK AND OTHER VESSELS, COMPLETE WITH CASES",
    });
  });

  it("records a cross-subheading export code without rejecting it", () => {
    // Legitimate when the tariff subheading has no export counterpart, so it
    // is surfaced for review rather than dropped.
    const { result: verified, verification } = verifyAgainstTariff(
      result([candidate({ hts_code: "8507.60.00.20", schedule_b: scheduleB() })]),
    );

    expect(verified.candidates[0].schedule_b?.code).toBe("9617.00.20.00");
    expect(verification.corrections).toContainEqual({
      htsCode: "8507.60.00.20",
      field: "schedule_b.hs_subheading",
      modelValue: "export code sits under 961700",
      indexValue: "HTS number sits under 850760",
    });
  });

  it("leaves a null export determination alone", () => {
    const { result: verified, verification } = verifyAgainstTariff(
      result([candidate({ schedule_b: null })]),
    );
    expect(verified.candidates[0].schedule_b).toBeNull();
    expect(verification.rejectedCodes).toEqual([]);
  });
});

describe("verifyAgainstTariff — recommendation handling", () => {
  it("keeps a null recommendation rather than promoting rank 1", () => {
    // Null is schema-mandated when the model needs more information. Filling
    // it in converts an explicit refusal into a recommendation, which the UI
    // then pre-selects — one click from a determination the model declined.
    const input = result([candidate()]);
    const { result: verified } = verifyAgainstTariff({
      ...input,
      status: "needs_more_info",
      recommended_hts_code: null,
    });
    expect(verified.recommended_hts_code).toBeNull();
  });

  it("still promotes when the recommendation itself failed verification", () => {
    // Here the model did commit to an answer — it just named a code that does
    // not exist, so falling back to the best surviving candidate is right.
    const input = result([candidate()]);
    const { result: verified } = verifyAgainstTariff({
      ...input,
      recommended_hts_code: "9999.99.99.99",
    });
    expect(verified.recommended_hts_code).toBe("8507.60.00.20");
  });

  it("keeps a recommendation that survived verification", () => {
    const { result: verified } = verifyAgainstTariff(result([candidate()]));
    expect(verified.recommended_hts_code).toBe("8507.60.00.20");
  });
});
