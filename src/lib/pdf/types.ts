import type { Candidate, ClassificationResult } from "../agent/schema";
import type { Chapter99ScreeningScope } from "../hts/store";

/**
 * Everything the determination PDF renders, assembled server-side.
 *
 * Deliberately a flat, self-contained snapshot rather than a set of database
 * references: a determination is a record of what was decided *at a moment*,
 * and re-rendering it later must not silently pick up a newer tariff edition
 * or a corrected analyst name.
 */
export interface DeterminationView {
  id: string;

  analyst: {
    name: string;
    email: string;
  };

  decidedAt: Date;
  htsusRevision: string;
  /**
   * Schedule B edition year, or null when no export schedule was synced.
   * Stamped separately because Census versions the export schedule annually
   * and independently of the HTSUS revision cycle.
   */
  scheduleBEdition: string | null;
  /**
   * What the tariff check did to the model's answer.
   *
   * On screen this is the analyst's strongest signal that a run went wrong —
   * codes that did not exist, rates the model mis-transcribed. Leaving it out
   * of the exported document made the artifact systematically more confident
   * than the screen it came from, which is the wrong direction for a record
   * someone may rely on without having watched the run.
   */
  verification: {
    /**
     * Codes that were checked and matched.
     *
     * Carried so a clean run can be stated as a finding rather than left as an
     * empty section. Optional because determinations recorded before this was
     * on the view have no count to give, and a document that cannot say how
     * many codes it checked should say "every code" rather than "0".
     */
    verifiedCodes?: string[];
    rejectedCodes: { code: string; reason: string }[];
    corrections: {
      htsCode: string;
      field: string;
      modelValue: string;
      indexValue: string;
      severity: "material" | "transcription";
    }[];
    /**
     * Set when the model's own recommendation failed verification and the best
     * surviving candidate was promoted in its place.
     *
     * On the document this matters more than on the screen, not less: months
     * later a reader has no way to tell that the code above was the
     * application's fallback rather than the analysis's conclusion, and the
     * fact that the run named a nonexistent code is the strongest signal
     * available about how much weight the rest of it deserves.
     */
    substitutedRecommendation: { modelSaid: string; using: string } | null;
    /**
     * Verified codes whose ten-digit reporting number is published somewhere
     * other than the line — for the Chapter 91 watch provisions, in the
     * chapter's statistical note.
     *
     * Carried onto the document because the determination is what someone reads
     * months later, with no access to the screen that explained it. A code that
     * needs a note to become a reporting number should say so next to itself.
     */
    reportingNumberNotes: {
      code: string;
      digits: number;
      source: "chapter_statistical_note" | "unpublished";
      footnote: string | null;
    }[];
  };
  /**
   * When the tariff snapshot was pulled. Chapter 99 duties are captured as
   * published at sync time and change faster than the HTSUS is revised, so
   * they have to be dated on the artifact rather than left to read as live.
   */
  tariffRetrievedAt: Date | null;
  /**
   * How far Chapter 99 screening reached in the snapshot this was decided
   * against, frozen on the determination row.
   *
   * Printed so the reader can size the claim rather than infer one: a
   * determination showing no additional duties is making a statement about the
   * screening as much as about the goods.
   *
   * Null for a determination recorded before it was frozen, and deliberately
   * not filled in from today's snapshot: those rows were decided against an
   * edition this deployment may no longer hold, and printing current coverage
   * under an older revision label is the defect the freezing exists to close.
   */
  chapter99Scope: Chapter99ScreeningScope | null;
  model: string;
  effort: string;
  appVersion: string;

  subject: {
    mode: "PART_NUMBER" | "DESCRIPTION";
    input: string;
    researched: ClassificationResult["researched_product"];
    refinements: { question: string; answer: string }[];
  };

  /** The code the analyst selected. */
  selected: Candidate;

  /** The top rejected alternates, with rejection rationale. */
  alternates: Candidate[];
  /**
   * How many candidates were passed over in total, before the list above was
   * capped at MAX_ALTERNATES.
   *
   * The section is headed "considered and rejected" and silently dropped the
   * sixth, so a reader could not tell a complete list from a truncated one.
   */
  alternatesConsidered: number;

  assumptions: string[];
  analystNote: string | null;

  /** True when the analyst chose something other than the model's rank 1. */
  overrodeRecommendation: boolean;
  modelRecommendation: string | null;
}
