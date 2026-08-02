import { describe, expect, it } from "vitest";
import type { ClassificationRun } from "../agent/classify";
import type { Candidate } from "../agent/schema";
import { sampleDeterminationView } from "../../test/determination-fixture";
import {
  MAX_ALTERNATES,
  buildDeterminationView,
  findCandidate,
  parseRefinements,
  selectAlternates,
} from "./buildView";

function candidate(rank: number, code: string): Candidate {
  return {
    rank,
    hts_code: code,
    description_path: ["Heading", "Subheading", "Statistical"],
    confidence: 0.7,
    gri_analysis: {
      gri_1: "GRI 1 reasoning.",
      gri_2: null,
      gri_3: null,
      gri_4: null,
      gri_5: null,
      gri_6: "GRI 6 reasoning.",
      additional_us_rules: null,
    },
    notes_applied: [],
    justification: `Justification for ${code}.`,
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
    why_not_selected: rank === 1 ? null : `Loses because of rank ${rank}.`,
  };
}

function run(
  candidates: Candidate[],
  recommended: string | null,
): ClassificationRun {
  return {
    result: {
      status: "complete",
      htsus_revision: "2026 HTS Revision 13",
      summary: "Summary.",
      researched_product: null,
      clarifying_questions: [],
      candidates,
      recommended_hts_code: recommended,
      assumptions: ["Assumed stainless steel."],
      info_that_would_raise_confidence: [],
    },
    verification: { verifiedCodes: [], rejectedCodes: [], corrections: [] },
    usage: { inputTokens: 1000, outputTokens: 500 },
    model: "claude-opus-5",
    effort: "max",
    htsusRevision: "2026 HTS Revision 13",
    durationMs: 90_000,
  };
}

describe("findCandidate", () => {
  const candidates = [
    candidate(1, "8507.60.00.20"),
    candidate(2, "9617.00.10.00"),
  ];

  it("matches regardless of dot formatting", () => {
    expect(findCandidate(candidates, "8507600020")?.rank).toBe(1);
    expect(findCandidate(candidates, "9617.00.10.00")?.rank).toBe(2);
  });

  it("returns null for a code that is not a candidate", () => {
    expect(findCandidate(candidates, "7323.93.00.80")).toBeNull();
  });
});

describe("selectAlternates", () => {
  const candidates = [
    candidate(1, "8507.60.00.20"),
    candidate(2, "9617.00.10.00"),
    candidate(3, "7323.93.00.80"),
  ];

  it("excludes whatever the analyst selected", () => {
    const alternates = selectAlternates(candidates, "8507.60.00.20");
    expect(alternates.map((c) => c.hts_code)).toEqual([
      "9617.00.10.00",
      "7323.93.00.80",
    ]);
  });

  it("includes the model's rank 1 when the analyst overrode it", () => {
    // If the analyst passed over the top-ranked code, the determination has to
    // show why — so rank 1 becomes an alternate rather than disappearing.
    const alternates = selectAlternates(candidates, "7323.93.00.80");
    expect(alternates.map((c) => c.hts_code)).toEqual([
      "8507.60.00.20",
      "9617.00.10.00",
    ]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      candidate(i + 1, `85076000${String(i).padStart(2, "0")}`),
    );
    expect(selectAlternates(many, "8507600000")).toHaveLength(MAX_ALTERNATES);
  });

  it("matches the selection regardless of formatting", () => {
    expect(selectAlternates(candidates, "8507600020")).toHaveLength(2);
  });
});

describe("parseRefinements", () => {
  it("reads a stored array", () => {
    expect(
      parseRefinements(
        '[{"questionId":"m","question":"Material?","answer":"Steel"}]',
      ),
    ).toEqual([{ questionId: "m", question: "Material?", answer: "Steel" }]);
  });

  it("returns an empty list for junk rather than throwing", () => {
    expect(parseRefinements("not json")).toEqual([]);
    expect(parseRefinements('{"not":"an array"}')).toEqual([]);
  });
});

describe("buildDeterminationView", () => {
  const candidates = [
    candidate(1, "8507.60.00.20"),
    candidate(2, "9617.00.10.00"),
  ];

  function build(selectedCode: string, recommended: string | null) {
    const selected = findCandidate(candidates, selectedCode)!;
    return buildDeterminationView({
      determinationId: "det_1",
      analyst: { name: "Dana Okafor", email: "dana@example.com" },
      decidedAt: new Date("2026-07-31T14:00:00Z"),
      htsusRevision: "2026 HTS Revision 13",
      scheduleBEdition: "2026",
      tariffRetrievedAt: new Date("2026-07-30T09:00:00Z"),
      model: "claude-opus-5",
      effort: "max",
      appVersion: "0.1.0",
      analystNote: null,
      mode: "DESCRIPTION",
      input: "A lithium-ion battery.",
      refinements: [],
      run: run(candidates, recommended),
      selected,
      alternates: selectAlternates(candidates, selectedCode),
    });
  }

  it("does not flag an override when the analyst took the model's pick", () => {
    const view = build("8507.60.00.20", "8507.60.00.20");
    expect(view.overrodeRecommendation).toBe(false);
  });

  it("flags an override when the analyst picked something else", () => {
    const view = build("9617.00.10.00", "8507.60.00.20");
    expect(view.overrodeRecommendation).toBe(true);
    expect(view.modelRecommendation).toBe("8507.60.00.20");
  });

  it("does not flag an override on formatting differences alone", () => {
    const view = build("8507.60.00.20", "8507600020");
    expect(view.overrodeRecommendation).toBe(false);
  });

  it("does not flag an override when the model made no recommendation", () => {
    const view = build("8507.60.00.20", null);
    expect(view.overrodeRecommendation).toBe(false);
  });

  it("carries the analysis assumptions onto the determination", () => {
    expect(build("8507.60.00.20", "8507.60.00.20").assumptions).toEqual([
      "Assumed stainless steel.",
    ]);
  });
});

describe("provenance is frozen, not joined", () => {
  // Two reviewers independently found the same defect: the PDF read the
  // analyst's name through a Prisma relation to a row that is rewritten on
  // every sign-in, so renaming an analyst silently re-authored determinations
  // they had already exported. These assert the shape that prevents it.
  it("renders the analyst identity it is given, not one looked up later", () => {
    const view = sampleDeterminationView({
      analyst: { name: "Dana Okafor", email: "dana.okafor@example.com" },
    });
    expect(view.analyst).toEqual({
      name: "Dana Okafor",
      email: "dana.okafor@example.com",
    });
  });

  it("carries the tariff retrieval date so Chapter 99 duties can be dated", () => {
    const view = sampleDeterminationView();
    expect(view.tariffRetrievedAt).toBeInstanceOf(Date);
  });

  it("tolerates a determination with no recorded retrieval date", () => {
    // Rows decided before the column existed. The document must still render;
    // it simply omits the date rather than inventing one.
    const view = sampleDeterminationView({ tariffRetrievedAt: null });
    expect(view.tariffRetrievedAt).toBeNull();
  });
});
