import type { Candidate, ClassificationResult } from "../agent/schema";

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
    rejectedCodes: { code: string; reason: string }[];
    corrections: { htsCode: string; field: string; modelValue: string; indexValue: string }[];
  };
  /**
   * When the tariff snapshot was pulled. Chapter 99 duties are captured as
   * published at sync time and change faster than the HTSUS is revised, so
   * they have to be dated on the artifact rather than left to read as live.
   */
  tariffRetrievedAt: Date | null;
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

  assumptions: string[];
  analystNote: string | null;

  /** True when the analyst chose something other than the model's rank 1. */
  overrodeRecommendation: boolean;
  modelRecommendation: string | null;
}
