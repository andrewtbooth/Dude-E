/**
 * Build replay cassettes from the committed determination fixture.
 *
 * The browser suites replay a recorded run so they cost nothing, and a
 * recording is gitignored because it holds whatever was classified. That made
 * the suites unrunnable from a fresh clone: no cassette, no way to make one
 * without a live model run and an API key. This writes the two the suites
 * expect from `src/test/determination-fixture.ts`, which is public tariff text
 * about a water bottle, so a clean checkout can run them.
 *
 * A synthetic cassette proves the plumbing, exactly as a recorded one does and
 * nothing more. The run it yields is still stamped `replay:` by the replayer.
 *
 *   npx tsx scripts/dev/synth-cassettes.ts
 */

import type { ClassificationRun, ProgressEvent } from "../../src/lib/agent/classify";
import type { Candidate, ClarifyingQuestion } from "../../src/lib/agent/schema";
import { writeCassette } from "../../src/lib/agent/replay";
import { sampleDeterminationView } from "../../src/test/determination-fixture";

const view = sampleDeterminationView();
const candidates: Candidate[] = [view.selected, ...view.alternates];

/**
 * Enough events, slowly enough, for the progress log to overflow its box —
 * the UX suite samples the log during the run and fails if it never scrolled.
 */
function progress(): ProgressEvent[] {
  const steps: ProgressEvent[] = [
    { type: "status", message: `Classifying against ${view.htsusRevision} using claude-opus-5 at max effort.` },
    { type: "thinking", text: "A double-walled stainless bottle with an evacuated cavity is a vacuum vessel; heading 9617 names those specifically." },
  ];
  const tools: [string, string][] = [
    ["hts_search", 'searching the tariff for "vacuum vessel"'],
    ["hts_search", 'searching the tariff for "vacuum flask stainless"'],
    ["hts_notes", "reading chapter 96 notes"],
    ["hts_notes", "reading section XX notes"],
    ["hts_subtree", "reading the breakouts under 9617"],
    ["hts_lookup", "verifying 9617.00.10.00"],
    ["hts_search", 'searching the tariff for "household articles stainless steel"'],
    ["hts_notes", "reading chapter 73 notes"],
    ["hts_notes", "reading section XV notes"],
    ["hts_lookup", "verifying 7323.93.00.80"],
    ["hts_notes", "reading chapter 39 notes"],
    ["hts_lookup", "verifying 3924.10.40.00"],
    ["hts_lookup", "verifying 9617.00.60.00"],
    ["hts_gri", "reading the General Rules of Interpretation"],
    ["chapter99_lookup", "checking Chapter 99 duties for 9617.00.10.00"],
    ["schedule_b_lookup", "listing Schedule B export codes for 9617.00.10.00"],
  ];
  for (const [name, summary] of tools) {
    steps.push({ type: "tool_use", name, summary });
    steps.push({ type: "thinking", text: `Read the result of ${name}; ${summary.split(" ")[0]} narrows the candidates.` });
  }
  steps.push({ type: "status", message: "Verifying codes against the tariff…" });
  return steps;
}

function run(overrides: Partial<ClassificationRun["result"]>, verification: Partial<ClassificationRun["verification"]> = {}): ClassificationRun {
  return {
    result: {
      status: "complete",
      htsus_revision: view.htsusRevision,
      summary: "A complete stainless vacuum vessel put up for retail sale, classified under heading 9617 at GRI 1; Section XV Note 1(k) forecloses heading 7323.",
      researched_product: null,
      clarifying_questions: [],
      candidates,
      recommended_hts_code: view.selected.hts_code,
      assumptions: view.assumptions,
      info_that_would_raise_confidence: [
        "Country of origin, to confirm whether any Chapter 99 trade-remedy duties apply.",
        "Confirmation that the cavity is evacuated rather than foam-filled.",
      ],
      ...overrides,
    },
    verification: {
      verifiedCodes: candidates.map((candidate) => candidate.hts_code),
      rejectedCodes: [],
      corrections: [],
      substitutedRecommendation: null,
      reportingNumberNotes: [],
      ...verification,
    },
    usage: { inputTokens: 1_812, cacheWriteTokens: 4_252, cacheReadTokens: 92_424, outputTokens: 2_857 },
    model: "claude-opus-5",
    effort: "max",
    htsusRevision: view.htsusRevision,
    durationMs: 61_000,
  };
}

// One correction that differs only in punctuation and a leading number — the
// shape every real run produces — left without a severity so the replayer's
// backfill classifies it, as it does for a cassette recorded before severity
// existed.
const path = view.selected.description_path;
const transcriptionOnly = {
  htsCode: view.selected.hts_code,
  field: "description_path",
  modelValue: [`9617.00 ${path[0].replace(/:$/, "")}`, ...path.slice(1)].join(" > "),
  indexValue: path.join(" > "),
} as ClassificationRun["verification"]["corrections"][number];

writeCassette(
  "data/cassettes/water-bottle.json",
  { mode: "DESCRIPTION", input: view.subject.input, refinements: 0 },
  [...progress(), { type: "done", run: run({}, { corrections: [transcriptionOnly] }) }],
);

const questions: ClarifyingQuestion[] = [
  {
    id: "material",
    question: "What is the housing made of?",
    why_it_matters: "Plastics fall to Chapter 39, metals to Section XV; nothing else can be decided first.",
    answer_type: "single_choice",
    options: ["Plastic", "Steel", "Aluminium"],
  },
  {
    id: "features",
    question: "Which of these does the housing include?",
    why_it_matters: "An enclosure with electrical fittings is an article of heading 8538, not a plastic article.",
    answer_type: "multi_choice",
    options: ["Terminals", "Gasket", "Mounting flange", "None"],
  },
  {
    id: "end_use",
    question: "What is it a housing for?",
    why_it_matters: "A part is classified with its machine where a Section XVI note directs it.",
    answer_type: "text",
    options: [],
  },
];

writeCassette(
  "data/cassettes/vague-plastic-housing.json",
  { mode: "DESCRIPTION", input: "plastic housing", refinements: 0 },
  [
    { type: "status", message: `Classifying against ${view.htsusRevision} using claude-opus-5 at max effort.` },
    { type: "tool_use", name: "hts_search", summary: 'searching the tariff for "plastic housing"' },
    { type: "status", message: "Verifying codes against the tariff…" },
    {
      type: "done",
      run: run(
        {
          status: "needs_more_info",
          summary: "Too little is known to choose a heading: material and fittings both decide it.",
          clarifying_questions: questions,
          candidates: [{ ...view.alternates[1], rank: 1, reasoning: { ...view.alternates[1].reasoning, why_not_selected: null } }],
          recommended_hts_code: null,
          assumptions: [],
          info_that_would_raise_confidence: [],
        },
        { verifiedCodes: [view.alternates[1].hts_code] },
      ),
    },
  ],
);

console.log("wrote data/cassettes/water-bottle.json and data/cassettes/vague-plastic-housing.json");
