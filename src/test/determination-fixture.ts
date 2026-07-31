import type { Candidate } from "../lib/agent/schema";
import type { DeterminationView } from "../lib/pdf/types";

/**
 * A realistic worked example, shared by the PDF tests and the dev render
 * script so the two cannot drift.
 *
 * The vacuum-flask case is deliberate: Chapter 96 (vacuum vessel) against
 * Chapter 73 (household article of steel) is the classic GRI 1 tension, where
 * both headings read plausibly until you get to Section XV Note 1(k). It
 * exercises every section of the document — notes, alternates with real
 * rejection reasons, Chapter 99 exposure, Schedule B, and CROSS citations.
 */

export function sampleSelectedCandidate(): Candidate {
  return {
    rank: 1,
    hts_code: "9617.00.10.00",
    description_path: [
      "Vacuum flasks and other vacuum vessels, complete with cases; parts thereof other than glass inners:",
      "Vacuum flasks and other vacuum vessels, complete with cases",
      "Vacuum flasks and other vacuum vessels, complete with cases",
    ],
    confidence: 0.88,
    gri_analysis: {
      gri_1:
        "Heading 9617 provides eo nomine for vacuum flasks and other vacuum vessels, complete with cases. The merchandise is a double-walled stainless steel vessel evacuated between the walls and imported complete with its outer case, so it answers the terms of the heading directly. Heading 7323, covering table, kitchen or other household articles of iron or steel, was read alongside it because the vessel is undeniably an article of stainless steel.",
      gri_2: null,
      gri_3:
        "Were both headings to remain in play, GRI 3(a) would prefer the heading providing the most specific description. Heading 9617 describes the article by its defining construction and function; heading 7323 describes it only by material and general domestic use. 9617 prevails.",
      gri_4: null,
      gri_5:
        "The screw cap and lid are imported with the vessel and are of a kind normally sold with it, so GRI 5(b) treats them as part of the article rather than as separate goods.",
      gri_6:
        "Heading 9617 breaks out at the eight-digit level between complete vessels and parts. The merchandise is a complete vessel with its case, so 9617.00.10 applies, and the single statistical breakout beneath it gives 9617.00.10.00.",
      additional_us_rules: null,
    },
    notes_applied: [
      {
        reference: "Section XV Note 1(k)",
        effect:
          "Excludes articles of Chapter 96 from Section XV. Once the merchandise answers heading 9617, this note removes heading 7323 from contention rather than leaving a GRI 3 contest to resolve.",
      },
      {
        reference: "Chapter 96 Note 1",
        effect:
          "Reviewed for exclusions; none reaches vacuum vessels of heading 9617.",
      },
    ],
    justification:
      "A stainless steel vacuum-insulated bottle is a vacuum vessel complete with its case, which heading 9617 provides for by name. Classification is resolved at GRI 1 by the heading text read together with Section XV Note 1(k), which excludes Chapter 96 articles from the base metal section and forecloses the competing steel-article heading.",
    duty: {
      general: "7.2%",
      special: "Free (AU,BH,CL,CO,D,E,IL,JO,KR,MA,OM,P,PA,PE,S,SG)",
      column_2: "55%",
      rates_published_on: "9617.00.10",
    },
    unit_of_quantity: ["No."],
    chapter_99: [
      {
        hts_code: "9903.88.03",
        program: "Section 301 (China)",
        additional_duty: "The duty provided in the applicable subheading + 25%",
        applies_when:
          "Applies only if the country of origin is China. Origin was not stated by the analyst, so this is presented conditionally.",
      },
    ],
    schedule_b: [
      {
        code: "9617.00.0000",
        description: "Vacuum flasks and other vacuum vessels, complete with cases",
      },
    ],
    cross_rulings: [
      {
        ruling_number: "N301234",
        url: "https://rulings.cbp.gov/ruling/N301234",
        holding:
          "CBP classified a stainless steel vacuum-insulated travel mug with a plastic lid in 9617.00.10.00.",
        relevance:
          "Materially similar construction, materials and function. Directly supports this classification.",
      },
    ],
    why_not_selected: null,
  };
}

function sampleAlternate(
  rank: number,
  htsCode: string,
  description: string,
  reason: string,
): Candidate {
  return {
    ...sampleSelectedCandidate(),
    rank,
    hts_code: htsCode,
    confidence: 0.35,
    description_path: [description, description],
    notes_applied: [],
    cross_rulings: [],
    chapter_99: [],
    schedule_b: [],
    why_not_selected: reason,
  };
}

export function sampleDeterminationView(
  overrides: Partial<DeterminationView> = {},
): DeterminationView {
  return {
    id: "det_01hq8xr4zk9m2p",
    analyst: { name: "Dana Okafor", email: "dana.okafor@example.com" },
    decidedAt: new Date("2026-07-31T14:22:05Z"),
    htsusRevision: "2026 HTS Revision 13",
    model: "claude-opus-5",
    effort: "max",
    appVersion: "0.1.0",
    subject: {
      mode: "DESCRIPTION",
      input:
        "Stainless steel vacuum-insulated water bottle, 32 oz capacity, double-walled 18/8 stainless construction, powder-coated exterior, polypropylene screw cap with integrated carry loop. Imported individually boxed and put up for retail sale.",
      researched: null,
      refinements: [
        {
          question: "Is the bottle put up for retail sale as imported, or in bulk?",
          answer: "Individually boxed for retail sale.",
        },
        {
          question:
            "Is the vacuum vessel imported complete with its outer case, or as a glass inner only?",
          answer: "Complete — the stainless outer body is the case.",
        },
      ],
    },
    selected: sampleSelectedCandidate(),
    alternates: [
      sampleAlternate(
        2,
        "7323.93.00.80",
        "Table, kitchen or other household articles of stainless steel",
        "Heading 7323 covers household articles of steel generally and would otherwise describe the merchandise. Section XV Note 1(k) excludes articles of Chapter 96 from Section XV, and heading 9617 names vacuum vessels specifically, so 7323 is foreclosed at GRI 1 rather than surviving to a GRI 3 contest.",
      ),
      sampleAlternate(
        3,
        "3924.10.40.00",
        "Tableware and kitchenware of plastics",
        "The polypropylene cap is a component of the article, not its essential character. The vessel body, which gives the article its identity and function, is steel with an evacuated cavity. GRI 3(b) does not reach this heading.",
      ),
      sampleAlternate(
        4,
        "9617.00.60.00",
        "Parts of vacuum vessels other than glass inners",
        "This provision covers parts imported separately. The merchandise is a complete vessel, so the parts breakout does not apply under GRI 6.",
      ),
    ],
    assumptions: [
      "The space between the walls is evacuated rather than merely filled with foam insulation. A foam-insulated bottle would not be a vacuum vessel and would fall to heading 7323.",
      "Country of origin was not stated, so Section 301 exposure is presented conditionally.",
    ],
    analystNote: null,
    overrodeRecommendation: false,
    modelRecommendation: "9617.00.10.00",
    ...overrides,
  };
}
