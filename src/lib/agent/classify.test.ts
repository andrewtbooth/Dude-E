import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupFixtureIndex, teardownFixtureIndex } from "../../test/htsus-fixture";
import { backfillRunFields, verifyAgainstTariff } from "./classify";
import type { ClassificationRun } from "./classify";
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

  it("drops a code the schedule breaks out further", () => {
    // 8507.60.00 publishes statistical breakouts beneath it, so it is a rate
    // line rather than something you can put on an entry. The rejection says
    // that, rather than asserting a rule about digit counts — Chapter 98 and
    // the Chapter 91 watch provisions terminate at eight digits and are
    // perfectly declarable, and the old message called them undeclarable in
    // writing, inside the determination.
    const { verification } = verifyAgainstTariff(
      result([candidate({ hts_code: "8507.60.00" })]),
    );

    expect(verification.verifiedCodes).toEqual([]);
    expect(verification.rejectedCodes[0].reason).toMatch(
      /not the deepest published line/,
    );
    expect(verification.rejectedCodes[0].reason).not.toMatch(/8-digit/);
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
      severity: "material",
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

  it("calls a wrong path material and a re-typed one transcription", () => {
    // Every correction observed in a real run so far has been the second kind:
    // the model quoting the schedule's own wording with the leading tariff
    // number left on or the trailing colon dropped. Those were driving a
    // warning banner that said values had been "replaced with what the
    // published schedule actually says" — true, but describing punctuation in
    // the language reserved for a wrong duty rate. The two have to be told
    // apart before either can be presented honestly.
    const { verification: wrong } = verifyAgainstTariff(
      result([candidate({ description_path: ["Wrong", "Path"] })]),
    );
    expect(
      wrong.corrections.find((c) => c.field === "description_path")?.severity,
    ).toBe("material");

    const { verification: retyped } = verifyAgainstTariff(
      result([
        candidate({
          description_path: [
            "8507 Electric storage batteries, including separators therefor; parts thereof",
            "8507.60 Lithium-ion batteries",
            "Other",
            "Other",
          ],
        }),
      ]),
    );
    expect(
      retyped.corrections.find((c) => c.field === "description_path")?.severity,
    ).toBe("transcription");
  });

  it("raises nothing at all when the path matches exactly", () => {
    const { verification } = verifyAgainstTariff(
      result([
        candidate({
          description_path: [
            "Electric storage batteries, including separators therefor; parts thereof:",
            "Lithium-ion batteries:",
            "Other",
            "Other",
          ],
        }),
      ]),
    );
    expect(
      verification.corrections.filter((c) => c.field === "description_path"),
    ).toEqual([]);
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

  /**
   * `why_not_selected` is a rejection rationale, so it belongs on every
   * candidate except the one that was selected — which is the recommendation,
   * not whatever ended up at rank 1. Keying it off the index agreed with the
   * recommendation only in the common case, and disagreed in exactly the two
   * cases worth getting right.
   */
  it("clears why_not_selected on the recommendation", () => {
    const { result: verified } = verifyAgainstTariff(
      result([
        candidate({ rank: 1, hts_code: "0000.00.00.00" }),
        candidate({ rank: 2, hts_code: "9617.00.10.00", why_not_selected: "loses on GRI 3(b)" }),
      ]),
    );

    expect(verified.recommended_hts_code).toBe("9617.00.10.00");
    expect(verified.candidates[0].reasoning.why_not_selected).toBeNull();
  });

  it("leaves it on rank 1 when the model recommended something below it", () => {
    // The rank-1 candidate here was genuinely passed over, and its rationale
    // is the reader's account of why. Clearing it deleted that account, and
    // left the recommended code carrying a note explaining why it lost —
    // printed under a heading claiming it as the answer.
    const base = result([
      candidate({ rank: 1, hts_code: "9617.00.10.00", why_not_selected: "no vacuum flask body" }),
      candidate({ rank: 2, hts_code: "7323.93.00.80", why_not_selected: "loses on GRI 3(b)" }),
    ]);
    base.recommended_hts_code = "7323.93.00.80";

    const { result: verified } = verifyAgainstTariff(base);

    expect(verified.candidates[0].reasoning.why_not_selected).toBe(
      "no vacuum flask body",
    );
    expect(verified.candidates[1].reasoning.why_not_selected).toBeNull();
  });

  it("clears nothing when the run recommended nothing", () => {
    // `needs_more_info` selects no code at all, so no candidate's rationale is
    // spent — rank 1's was being cleared for a selection that never happened.
    const base = result([
      candidate({ rank: 1, hts_code: "9617.00.10.00", why_not_selected: "material unknown" }),
    ]);
    base.status = "needs_more_info";
    base.recommended_hts_code = null;

    const { result: verified } = verifyAgainstTariff(base);

    expect(verified.recommended_hts_code).toBeNull();
    expect(verified.candidates[0].reasoning.why_not_selected).toBe(
      "material unknown",
    );
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
      severity: "material",
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
      severity: "material",
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

  it("records that the promoted code is the app's choice, not the model's", () => {
    // The recovery above is right and also invisible: recommended_hts_code
    // comes back populated either way, so a code this application picked is
    // presented in the same terms as one the model picked — on a screen that
    // prints it at the top of the page as the answer. A model naming a code
    // that does not exist is the strongest available signal that the analysis
    // needs a second look, and the fallback was swallowing it.
    const { verification } = verifyAgainstTariff({
      ...result([candidate()]),
      recommended_hts_code: "9999.99.99.99",
    });
    expect(verification.substitutedRecommendation).toEqual({
      modelSaid: "9999.99.99.99",
      using: "8507.60.00.20",
    });
  });

  it("records no substitution when the model's own pick verified", () => {
    const { verification } = verifyAgainstTariff(result([candidate()]));
    expect(verification.substitutedRecommendation).toBeNull();
  });

  it("records no substitution when the model declined to recommend", () => {
    // Declining is not a failed recommendation, and must not be reported as
    // one — there is nothing the application substituted for.
    const { verification } = verifyAgainstTariff({
      ...result([candidate()]),
      status: "needs_more_info",
      recommended_hts_code: null,
    });
    expect(verification.substitutedRecommendation).toBeNull();
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

describe("backfillRunFields", () => {
  // Determinations are stored as the classifier returned them, and cassettes
  // are recorded the same way, so both go on carrying the shape they had when
  // written. Reading one back through a cast produces an object that satisfies
  // the type and is missing the field anyway — which is worse than a null,
  // because nothing complains and every branch on it quietly takes the wrong
  // side.
  const run = (
    corrections: Record<string, unknown>[],
  ): ClassificationRun =>
    ({
      verification: { verifiedCodes: [], rejectedCodes: [], corrections },
    }) as unknown as ClassificationRun;

  it("reads severity off the record rather than assuming it", () => {
    // The values are both preserved on the correction, so the same comparison
    // the classifier makes today can be made about a row written before it
    // existed. No guess is required and none should be made.
    const backfilled = backfillRunFields(
      run([
        {
          htsCode: "9617.00.10.00",
          field: "description_path",
          modelValue: "9617.00 Vacuum flasks and other vacuum vessels",
          indexValue: "Vacuum flasks and other vacuum vessels:",
        },
      ]),
    );
    expect(backfilled.verification.corrections[0].severity).toBe("transcription");
  });

  it("keeps an unclassifiable correction visible", () => {
    // A duty rate carries no paths to compare. Defaulting it to material is
    // the reading that keeps showing it; defaulting the other way would hide
    // a wrong number behind a disclosure labelled "punctuation".
    const backfilled = backfillRunFields(
      run([
        {
          htsCode: "9617.00.10.00",
          field: "duty.general",
          modelValue: "3.4%",
          indexValue: "7.2%",
        },
      ]),
    );
    expect(backfilled.verification.corrections[0].severity).toBe("material");
  });

  it("calls a genuinely different path material", () => {
    const backfilled = backfillRunFields(
      run([
        {
          htsCode: "9617.00.10.00",
          field: "description_path",
          modelValue: "Wrong > Path",
          indexValue: "Vacuum flasks and other vacuum vessels:",
        },
      ]),
    );
    expect(backfilled.verification.corrections[0].severity).toBe("material");
  });

  it("does not overwrite a severity the classifier already set", () => {
    const backfilled = backfillRunFields(
      run([
        {
          htsCode: "9617.00.10.00",
          field: "description_path",
          modelValue: "9617.00 Vacuum flasks",
          indexValue: "Vacuum flasks",
          severity: "material",
        },
      ]),
    );
    expect(backfilled.verification.corrections[0].severity).toBe("material");
  });
});

describe("verifyAgainstTariff — where the reporting number is published", () => {
  /**
   * 9101.11.40 is real: a watch provision with nothing beneath it in the
   * tariff tree and no unit of quantity, and one of 95 like it in Chapter 91.
   *
   * The first version of this check counted digits and concluded the schedule
   * published no reporting number for them. It publishes every one, in chapter
   * statistical note 1, as a suffix appended to the eight-digit subheading —
   * and the missing unit of quantity, offered at the time as corroboration, is
   * a consequence of that scheme rather than evidence against it, because the
   * article is reported as separately valued components with a unit each.
   *
   * So the recorded fact is where the number comes from, read from the
   * footnote the line actually carries.
   */
  it("records that the number comes from the chapter statistical note", () => {
    const { result: verified, verification } = verifyAgainstTariff(
      result([candidate({ hts_code: "9101.11.40" })]),
    );

    expect(verified.candidates.map((c) => c.hts_code)).toEqual(["9101.11.40"]);
    expect(verification.rejectedCodes).toEqual([]);
    expect(verification.reportingNumberNotes).toEqual([
      {
        code: "9101.11.40",
        digits: 8,
        source: "chapter_statistical_note",
        footnote: "See statistical note 1 to this chapter.",
      },
    ]);
  });

  it("says nothing about a line that prints its own reporting number", () => {
    const { verification } = verifyAgainstTariff(result([candidate()]));
    expect(verification.reportingNumberNotes).toEqual([]);
  });

  it("recomputes it for a run stored before the field existed", () => {
    // Recoverable, unlike the substituted recommendation — but only against
    // the index, since the answer is in the line's footnotes and a stored run
    // keeps codes. Old runs carry `incompleteReportingNumbers`, whose entries
    // asserted the wrong thing; they are re-examined rather than translated.
    const stored = {
      verification: {
        verifiedCodes: ["9101.11.40", "8507.60.00.20"],
        rejectedCodes: [],
        corrections: [],
        substitutedRecommendation: null,
        incompleteReportingNumbers: [{ code: "9101.11.40", digits: 8 }],
      },
    } as unknown as ClassificationRun;

    expect(
      backfillRunFields(stored).verification.reportingNumberNotes,
    ).toEqual([
      {
        code: "9101.11.40",
        digits: 8,
        source: "chapter_statistical_note",
        footnote: "See statistical note 1 to this chapter.",
      },
    ]);
  });
});

describe("verifyAgainstTariff — Chapter 98 is claimed, not classified", () => {
  /**
   * This application produces the classification a product carries in a library
   * and reuses across every shipment. A Chapter 98 provision is a fact about
   * one importation — exported and returned, temporarily under bond,
   * originating under USMCA — so it cannot be what the product *is*, and the
   * same product can arrive under a different provision, or none, next month.
   *
   * Task #14 made these declarable, which fixed a real bug (they were being
   * rejected with a message denying they could be entered at all) and created
   * this one: they became eligible to be the recommended code.
   */
  it("refuses a Chapter 98 provision as a candidate", () => {
    const { result: verified, verification } = verifyAgainstTariff(
      result([candidate({ hts_code: "9813.00.20" })]),
    );
    expect(verified.candidates).toEqual([]);
    expect(verification.verifiedCodes).toEqual([]);
  });

  it("says why in terms of the product, not the digits", () => {
    // The reason is printed into the determination's discarded list. "8 digits
    // cannot be declared" would be false; "not a classification" is the point.
    const { verification } = verifyAgainstTariff(
      result([candidate({ hts_code: "9813.00.20" })]),
    );
    const reason = verification.rejectedCodes[0]?.reason ?? "";
    expect(reason).toMatch(/circumstances of a particular importation/);
    expect(reason).toMatch(/claimed alongside/);
    expect(reason).not.toMatch(/digit/);
  });

  it("keeps refusing Chapter 99, for the same structural reason", () => {
    const { verification } = verifyAgainstTariff(
      result([candidate({ hts_code: "9903.88.03" })]),
    );
    expect(verification.rejectedCodes[0]?.reason).toMatch(/alongside/);
  });

  it("leaves an ordinary classification alone", () => {
    const { result: verified } = verifyAgainstTariff(result([candidate()]));
    expect(verified.candidates).toHaveLength(1);
  });
});
