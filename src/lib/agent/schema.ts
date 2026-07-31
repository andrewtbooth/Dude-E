import * as z from "zod/v4";

/**
 * Structured output contract for a classification run.
 *
 * Two deliberate constraints throughout:
 *
 * - **Nullable, never optional.** Structured outputs require every property to
 *   be present, so an "absent" value is explicitly `null`. That also forces
 *   the model to say "GRI 3 did not apply" rather than quietly omitting it,
 *   which is the difference between an analysis and an assertion.
 *
 * - **Every claim carries its support.** A candidate cannot be just a code and
 *   a confidence number; it has to bring the GRI reasoning, the notes relied
 *   on, and the duty rates that were read off the tariff.
 */

export const GRI_STEPS = [
  "gri_1",
  "gri_2",
  "gri_3",
  "gri_4",
  "gri_5",
  "gri_6",
] as const;

export const griAnalysisSchema = z.object({
  gri_1: z
    .string()
    .describe(
      "How the terms of the competing headings and the relative Section/Chapter notes bear on this good. Always required — GRI 1 governs.",
    ),
  gri_2: z
    .string()
    .nullable()
    .describe(
      "GRI 2(a) incomplete/unassembled articles, or 2(b) mixtures and composite goods. Null if not reached.",
    ),
  gri_3: z
    .string()
    .nullable()
    .describe(
      "GRI 3(a) most specific description, 3(b) essential character, or 3(c) last in numerical order. Null if not reached.",
    ),
  gri_4: z
    .string()
    .nullable()
    .describe("GRI 4 goods most akin. Null if not reached."),
  gri_5: z
    .string()
    .nullable()
    .describe("GRI 5 cases, containers and packing materials. Null if not reached."),
  gri_6: z
    .string()
    .describe(
      "GRI 6 comparison at the subheading level, including which statistical breakout applies and why.",
    ),
  additional_us_rules: z
    .string()
    .nullable()
    .describe(
      "Additional U.S. Rules of Interpretation, e.g. principal use or actual use provisions. Null if not engaged.",
    ),
});

export const noteAppliedSchema = z.object({
  reference: z
    .string()
    .describe('Citation, e.g. "Section XVI Note 2(a)" or "Chapter 96 Note 1(f)".'),
  effect: z
    .string()
    .describe(
      "What this note did to the analysis — including notes that excluded a heading, which are as load-bearing as those that included one.",
    ),
});

export const dutySchema = z.object({
  general: z.string().describe("Column 1 General rate as published."),
  special: z
    .string()
    .describe("Column 1 Special rate and programme codes, or empty if none."),
  column_2: z.string().describe("Column 2 rate."),
  rates_published_on: z
    .string()
    .nullable()
    .describe(
      "The HTS number these rates were actually read from, when the classified line inherits them from a parent. Null when the line publishes its own.",
    ),
});

export const chapter99Schema = z.object({
  hts_code: z.string().describe('Chapter 99 subheading, e.g. "9903.88.03".'),
  program: z.string().describe('e.g. "Section 301 (China)".'),
  additional_duty: z.string().describe("Additional duty as published."),
  applies_when: z
    .string()
    .describe(
      "The condition that triggers it — usually country of origin. State it plainly; the analyst may not have supplied origin.",
    ),
});

export const scheduleBSchema = z.object({
  code: z.string(),
  description: z.string(),
});

export const crossRulingSchema = z.object({
  ruling_number: z.string().describe('e.g. "N123456" or "HQ H289712".'),
  url: z.string().describe("Link to the ruling on rulings.cbp.gov."),
  holding: z.string().describe("What CBP classified and to what code."),
  relevance: z
    .string()
    .describe("Why it does or does not control the good under analysis."),
});

export const candidateSchema = z.object({
  rank: z.number().int().describe("1 is the best-supported candidate."),
  hts_code: z
    .string()
    .describe(
      "The 10-digit statistical reporting number, dotted. Must be a code you verified with hts_lookup — never one you composed.",
    ),
  description_path: z
    .array(z.string())
    .describe("Heading through statistical suffix, outermost first."),
  confidence: z
    .number()
    .describe("0 to 1. Calibrated: reserve >0.9 for codes you would defend to CBP unaided."),
  gri_analysis: griAnalysisSchema,
  notes_applied: z.array(noteAppliedSchema),
  justification: z
    .string()
    .describe(
      "The argument for this code in plain prose, readable by someone who was not part of the analysis.",
    ),
  duty: dutySchema,
  unit_of_quantity: z.array(z.string()),
  chapter_99: z.array(chapter99Schema),
  schedule_b: z.array(scheduleBSchema),
  cross_rulings: z.array(crossRulingSchema),
  why_not_selected: z
    .string()
    .nullable()
    .describe(
      "For candidates below rank 1: the specific reason this one loses. Null for rank 1. This text is what appears in the exported determination's alternates section, so make it stand alone.",
    ),
});

export const clarifyingQuestionSchema = z.object({
  id: z.string().describe("Stable slug, e.g. 'material_composition'."),
  question: z.string(),
  why_it_matters: z
    .string()
    .describe(
      "Which classification branch this answer decides. If it does not change the outcome, do not ask it.",
    ),
  answer_type: z.enum(["text", "single_choice", "multi_choice", "number"]),
  options: z
    .array(z.string())
    .describe("Choices for single/multi choice questions; empty otherwise."),
});

export const researchedProductSchema = z.object({
  manufacturer: z.string().nullable(),
  product_name: z.string().nullable(),
  summary: z.string().describe("What the part is and what it does."),
  materials: z.array(z.string()),
  function: z.string().nullable(),
  end_use: z.string().nullable(),
  vendor_published_codes: z
    .array(
      z.object({
        code: z.string(),
        kind: z.enum(["HTS", "Schedule B", "HS", "unknown"]),
        source: z.string().describe("URL or publication the code came from."),
      }),
    )
    .describe(
      "Codes a manufacturer or distributor publishes. Evidence, not an answer — these are frequently wrong or country-specific.",
    ),
  sources: z.array(
    z.object({ url: z.string(), what_it_supported: z.string() }),
  ),
});

export const classificationResultSchema = z.object({
  status: z
    .enum(["needs_more_info", "complete"])
    .describe(
      "'needs_more_info' only when a missing fact genuinely changes the outcome. Otherwise classify on stated assumptions.",
    ),
  htsus_revision: z
    .string()
    .describe("The revision supplied to you. Echo it exactly."),
  summary: z
    .string()
    .describe("Two or three sentences an analyst can read before the detail."),
  researched_product: researchedProductSchema
    .nullable()
    .describe("Populated for part-number analyses; null for description-only."),
  clarifying_questions: z.array(clarifyingQuestionSchema),
  candidates: z
    .array(candidateSchema)
    .describe(
      "Ranked best first. Aim for 4 to 6 when the good is contestable so the determination can show real alternates.",
    ),
  recommended_hts_code: z
    .string()
    .nullable()
    .describe("The rank-1 code, or null when status is needs_more_info."),
  assumptions: z
    .array(z.string())
    .describe("Everything you took as given that the analyst did not state."),
  info_that_would_raise_confidence: z
    .array(z.string())
    .describe(
      "Facts that would firm up the call but were not blocking. Distinct from clarifying_questions.",
    ),
});

export type GriAnalysis = z.infer<typeof griAnalysisSchema>;
export type NoteApplied = z.infer<typeof noteAppliedSchema>;
export type Duty = z.infer<typeof dutySchema>;
export type Chapter99 = z.infer<typeof chapter99Schema>;
export type CrossRuling = z.infer<typeof crossRulingSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type ClarifyingQuestion = z.infer<typeof clarifyingQuestionSchema>;
export type ResearchedProduct = z.infer<typeof researchedProductSchema>;
export type ClassificationResult = z.infer<typeof classificationResultSchema>;

/** Answer supplied by the analyst to a clarifying question. */
export interface Refinement {
  questionId: string;
  question: string;
  answer: string;
}

export type AnalysisMode = "PART_NUMBER" | "DESCRIPTION";
