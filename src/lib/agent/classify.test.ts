import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupFixtureIndex, teardownFixtureIndex } from "../../test/htsus-fixture";
import { verifyAgainstTariff } from "./classify";
import type { Candidate, ClassificationResult } from "./schema";

beforeAll(() => setupFixtureIndex());
afterAll(() => teardownFixtureIndex());

/**
 * `duty`, `unit_of_quantity`, `chapter_99` and `why_not_selected` live inside
 * `tariff` / `reasoning` on the real type — they are grouped there to keep the
 * structured-output grammar under the API's size limit. These tests override
 * them by their own names so each case still reads as the one fact it is
 * about; the builder puts them back where they belong.
 */
type CandidateOverrides = Omit<Partial<Candidate>, "tariff" | "reasoning"> & {
  tariff?: Partial<Candidate["tariff"]>;
  reasoning?: Partial<Candidate["reasoning"]>;
  duty?: Candidate["tariff"]["duty"];
  unit_of_quantity?: Candidate["tariff"]["unit_of_quantity"];
  chapter_99?: Candidate["tariff"]["chapter_99"];
  why_not_selected?: Candidate["reasoning"]["why_not_selected"];
};

function candidate(overrides: CandidateOverrides = {}): Candidate {
  const {
    duty,
    unit_of_quantity,
    chapter_99,
    why_not_selected,
    tariff,
    reasoning,
    ...rest
  } = overrides;
  const base = {
    rank: 1,
    hts_code: "8507.60.00.20",
    description_path: ["Electric storage batteries", "Lithium-ion", "Other"],
    confidence: 0.8,
    reasoning: {
      gri_analysis: {
        gri_1: "Heading 8507 covers electric storage batteries eo nomine.",
        gri_2: null,
        gri_3: null,
        gri_4: null,
        gri_5: null,
        gri_6:
          "Not of a kind used as primary power for EVs, so the residual applies.",
        additional_us_rules: null,
      },
      notes_applied: [],
      justification: "A lithium-ion cell is provided for by name in 8507.60.",
      why_not_selected: null,
    },
    tariff: {
      duty: {
        general: "3.4%",
        special: "",
        column_2: "35%",
        rates_published_on: null,
      },
      unit_of_quantity: ["No."],
      chapter_99: [],
    },
    schedule_b: null,
    cross_rulings: [],
  } satisfies Candidate;

  return {
    ...base,
    ...rest,
    reasoning: {
      ...base.reasoning,
      ...reasoning,
      ...(why_not_selected !== undefined ? { why_not_selected } : {}),
    },
    tariff: {
      ...base.tariff,
      ...tariff,
      ...(duty !== undefined ? { duty } : {}),
      ...(unit_of_quantity !== undefined ? { unit_of_quantity } : {}),
      ...(chapter_99 !== undefined ? { chapter_99 } : {}),
    },
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

    expect(verified.candidates[0].tariff.duty.general).toBe("3.4%");
    expect(verified.candidates[0].tariff.duty.column_2).toBe("35%");
    // Inherited rates keep their provenance so the PDF can say so.
    expect(verified.candidates[0].tariff.duty.rates_published_on).toBe("8507.60.00");
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
    expect(verified.candidates[0].tariff.unit_of_quantity).toEqual(["No.", "kg"]);
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

    expect(verified.candidates[0].reasoning.why_not_selected).toBeNull();
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

describe("verifyAgainstTariff — Chapter 99 and rulings", () => {
  const ch99 = (overrides: Partial<Candidate["tariff"]["chapter_99"][number]> = {}) => ({
    hts_code: "9903.88.03",
    program: "Section 301 (China)",
    additional_duty: "The duty provided in the applicable subheading + 25%",
    applies_when: "Country of origin is China.",
    ...overrides,
  });

  const ruling = (overrides: Partial<Candidate["cross_rulings"][number]> = {}) => ({
    ruling_number: "N301234",
    url: "https://rulings.cbp.gov/ruling/N301234",
    holding: "CBP classified a comparable article in 8507.60.00.20.",
    relevance: "Materially similar construction.",
    ...overrides,
  });

  it("drops a Chapter 99 provision that does not exist", () => {
    // An invented "+25%" line is a larger duty error than most base-rate
    // mistakes, and it renders in the callout a reader is most likely to act on.
    const { result: verified, verification } = verifyAgainstTariff(
      result([candidate({ chapter_99: [ch99({ hts_code: "9903.99.99" })] })]),
    );
    expect(verified.candidates[0].tariff.chapter_99).toEqual([]);
    expect(verification.rejectedCodes[0].reason).toMatch(/not present/);
  });

  it("drops a provision that is real but is not Chapter 99", () => {
    const { result: verified, verification } = verifyAgainstTariff(
      result([candidate({ chapter_99: [ch99({ hts_code: "8507.60.00.20" })] })]),
    );
    expect(verified.candidates[0].tariff.chapter_99).toEqual([]);
    expect(verification.rejectedCodes[0].reason).toMatch(/not a Chapter 99/);
  });

  it("keeps a real provision and reads its duty text from the tariff", () => {
    const { result: verified } = verifyAgainstTariff(
      result([
        candidate({ chapter_99: [ch99({ additional_duty: "plus 10 percent" })] }),
      ]),
    );
    expect(verified.candidates[0].tariff.chapter_99[0].additional_duty).toBe(
      "The duty provided in the applicable subheading + 25%",
    );
  });

  it("rejects a ruling number that is not a CBP format", () => {
    const { result: verified, verification } = verifyAgainstTariff(
      result([candidate({ cross_rulings: [ruling({ ruling_number: "RULING-7" })] })]),
    );
    expect(verified.candidates[0].cross_rulings).toEqual([]);
    expect(verification.rejectedCodes[0].reason).toMatch(/ruling number format/);
  });

  /**
   * CBP has renumbered its rulings several times and every generation is still
   * live in CROSS. Rejecting one is not a quiet no-op: the number is written
   * into the determination's discarded list as "not a CBP ruling number
   * format", so a too-narrow pattern has the document assert to an auditor that
   * a real citation is malformed. These are the shapes that were being refused.
   */
  it.each([
    ["NY J80123", "the 2002-2005 NY letter series"],
    ["NY I89765", "the 2002-2005 NY letter series"],
    ["NY R02345", "the 2002-2005 NY letter series"],
    ["HQ W968156", "a pre-classification ruling"],
    ["HQ 967890", "the older six-digit HQ series"],
    ["HQ H289712", "current HQ"],
    ["NY N123456", "current NY"],
  ])("accepts %s (%s)", (rulingNumber) => {
    const { result: verified, verification } = verifyAgainstTariff(
      result([
        candidate({
          cross_rulings: [
            ruling({
              ruling_number: rulingNumber,
              // The URL check is separate and matches on the bare number.
              url: `https://rulings.cbp.gov/ruling/${rulingNumber.split(/\s+/).pop()}`,
            }),
          ],
        }),
      ]),
    );
    expect(verified.candidates[0].cross_rulings).toHaveLength(1);
    expect(
      verification.rejectedCodes.some((r) => /ruling number format/.test(r.reason)),
    ).toBe(false);
  });

  it("rejects a citation that links somewhere other than CBP", () => {
    const { result: verified, verification } = verifyAgainstTariff(
      result([
        candidate({
          cross_rulings: [ruling({ url: "https://example.com/ruling/N301234" })],
        }),
      ]),
    );
    expect(verified.candidates[0].cross_rulings).toEqual([]);
    expect(verification.rejectedCodes[0].reason).toMatch(/not CBP's ruling database/);
  });

  it("rejects a link that does not reference the ruling it cites", () => {
    const { result: verified, verification } = verifyAgainstTariff(
      result([
        candidate({
          cross_rulings: [ruling({ url: "https://rulings.cbp.gov/ruling/N999888" })],
        }),
      ]),
    );
    expect(verified.candidates[0].cross_rulings).toEqual([]);
    expect(verification.rejectedCodes[0].reason).toMatch(/does not reference/);
  });

  it("keeps a well-formed citation", () => {
    const { result: verified } = verifyAgainstTariff(
      result([candidate({ cross_rulings: [ruling()] })]),
    );
    expect(verified.candidates[0].cross_rulings).toHaveLength(1);
  });
});
