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
