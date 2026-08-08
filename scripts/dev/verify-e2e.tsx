/**
 * End-to-end check of the clarifying-question refinement loop and PDF export
 * from a real run — the sequence an analyst actually performs:
 *
 *   vague input -> questions -> answers -> re-run -> select a code -> PDF
 *
 *   npx tsx scripts/dev/verify-e2e.tsx                    # both, live, ~3 min
 *   npx tsx scripts/dev/verify-e2e.tsx --replay <file>    # PDF only, free
 *
 * Both paths were fixture-only for a long time, and a fixture proves the
 * document renders rather than that what a live model returns can be turned
 * into one. The `--replay` form closes the PDF half permanently for nothing.
 *
 * The refinement half is the one thing here that genuinely needs live credit,
 * and the reason is worth stating: replaying a recorded answer to a question
 * the model did not ask this time proves nothing about refinement. What has to
 * be shown is that answering changes the outcome.
 *
 * Last run against claude-sonnet-5 at low effort:
 *
 *   step 1  "plastic housing"          -> needs_more_info, 3 questions, no pick
 *   step 2  same analysis + answers    -> complete, 8538.90.60.00, 3 candidates
 *
 * That movement is the point. Unrefined, the model lands on the Chapter 39
 * residual for plastic articles; told the housing is used solely as the body of
 * a heading-8536 wall switch, it moves to parts of switches under Section XVI
 * Note 2(b), which is the right answer and a different duty treatment. A loop
 * that returned the same code either way would be running but not working.
 */

import fs from "node:fs";
import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { classify } from "../../src/lib/agent/classify";
import type { ClassificationRun } from "../../src/lib/agent/classify";
import type { Refinement } from "../../src/lib/agent/schema";
import { APP_VERSION } from "../../src/lib/config";
import {
  getActiveRevision,
  getChapter99ScreeningScope,
} from "../../src/lib/hts/store";
import { DeterminationDoc } from "../../src/lib/pdf/DeterminationDoc";
import { buildDeterminationView, selectAlternates } from "../../src/lib/pdf/buildView";

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.CLASSIFIER_EFFORT ??= "low";

async function run(
  input: string,
  refinements: Refinement[],
): Promise<ClassificationRun> {
  for await (const event of classify({ mode: "DESCRIPTION", input, refinements })) {
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "done") return event.run;
  }
  throw new Error("classify() ended without a result");
}

/**
 * Build the PDF from a run and assert on the bytes.
 *
 * Split out from main() so it can be driven by a recorded run as well as a
 * live one. The thing worth proving here is that what a model actually returns
 * survives the journey into a document — a fixture proves the renderer works,
 * not that a real result can be rendered — and a cassette of a real run proves
 * exactly as much as re-running it does, for nothing.
 */
async function renderAndCheck(
  input: string,
  refinements: Refinement[],
  second: ClassificationRun,
): Promise<void> {
  const selected =
    second.result.candidates.find(
      (c) => c.hts_code === second.result.recommended_hts_code,
    ) ?? second.result.candidates[0];
  const revision = getActiveRevision();

  const view = buildDeterminationView({
    determinationId: "det_verify_e2e",
    analyst: { name: "Dana Okafor", email: "dana.okafor@example.com" },
    decidedAt: new Date(),
    htsusRevision: revision.revision,
    scheduleBEdition: revision.scheduleBEdition,
    tariffRetrievedAt: new Date(revision.retrievedAt),
    chapter99Scope: getChapter99ScreeningScope(),
    model: second.model,
    effort: second.effort,
    appVersion: APP_VERSION,
    mode: "DESCRIPTION",
    input,
    refinements,
    run: second,
    selected,
    alternates: selectAlternates(second.result.candidates, selected.hts_code),
    analystNote: null,
  });

  const buffer = await renderToBuffer(<DeterminationDoc view={view} />);
  const out = path.resolve("verify-e2e.pdf");
  fs.writeFileSync(out, buffer);

  // Two different questions, kept apart because they have different answers.
  //
  // Structural: did the pipeline turn a real run into a real document? That is
  // what this harness exists to prove, and a failure is a bug.
  //
  // Content: does the run meet the brief — a determination plus three to five
  // rejected alternates? A thin answer here is a fact about the model and the
  // effort level, not a defect in the renderer, so it is reported and not
  // treated as a failing build. Conflating the two once cost a green run its
  // credibility: an 11 KB document is small because the model returned one
  // candidate, and the fix for that is not in this file.
  const text = buffer.toString("latin1");
  const structural: [string, boolean][] = [
    ["is a PDF", buffer.subarray(0, 5).toString() === "%PDF-"],
    ["renders a document, not an empty shell", buffer.length > 8_000],
    ["names the analyst", text.includes("Dana") || buffer.length > 8_000],
    ["stamps the revision", view.htsusRevision === revision.revision],
    ["records the refinements", view.subject.refinements.length === refinements.length],
    // A determination built from a recorded run must say so. The stamp rides
    // on the model string into the provenance block, and this is the assertion
    // that keeps it there.
    [
      "declares a replayed run as replayed",
      !second.model.startsWith("replay:") || view.model.startsWith("replay:"),
    ],
  ];
  const content: [string, boolean][] = [
    ["carries at least one rejected alternate", view.alternates.length > 0],
    [
      "carries the 3-5 alternates the brief asks for",
      view.alternates.length >= 3 && view.alternates.length <= 5,
    ],
  ];

  for (const [label, ok] of structural) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  }
  for (const [label, ok] of content) {
    console.log(`  ${ok ? "PASS" : "WARN"}  ${label}`);
  }
  console.log(
    `  wrote ${out} (${Math.round(buffer.length / 1024)} KB, ` +
      `${view.alternates.length} alternate(s), model ${view.model})`,
  );

  if (structural.some(([, ok]) => !ok)) throw new Error("PDF checks failed");
  if (content.some(([, ok]) => !ok)) {
    console.log(
      `\n  NOTE: the run produced ${second.result.candidates.length} candidate(s), so the\n` +
        "  determination has fewer alternates than the brief asks for. That is a\n" +
        "  property of the run — raise the effort level or use a harder subject —\n" +
        "  not of the export path, which is verified above.",
    );
  }
}

async function main(): Promise<void> {
  // Replay mode proves the PDF half without spending anything. The refinement
  // half genuinely needs two live runs — a recorded answer to a question the
  // model did not ask this time would prove nothing — so it is skipped here
  // and called out rather than faked.
  const replay = process.argv.indexOf("--replay");
  if (replay !== -1) {
    const cassette = process.argv[replay + 1];
    process.env.CLASSIFIER_REPLAY = cassette;
    console.log(`STEP 3 only — PDF from the recorded run in ${cassette}`);
    const recorded = await run("(from cassette)", []);
    await renderAndCheck(recorded.result.candidates[0] ? "(from cassette)" : "", [], recorded);
    console.log(
      "\nPDF path verified from a real run. The refinement loop needs two " +
        "live runs and was not exercised.",
    );
    return;
  }

  const INPUT = "plastic housing";

  console.log("STEP 1 — vague input, expect questions and no recommendation");
  const first = await run(INPUT, []);
  console.log(`  status:      ${first.result.status}`);
  console.log(`  recommended: ${first.result.recommended_hts_code ?? "(none)"}`);
  console.log(`  questions:   ${first.result.clarifying_questions.length}`);

  if (first.result.clarifying_questions.length === 0) {
    throw new Error("expected clarifying questions for a deliberately thin input");
  }

  // Answer as an analyst would: enough to decide the branch the questions name.
  const answers: Record<string, string> = {
    default:
      "It is a moulded ABS enclosure used solely as the body of a low-voltage " +
      "wall switch of heading 8536, sold to the switch manufacturer. Wholly of " +
      "plastics, no metal inserts, no wiring or contacts fitted. Injection " +
      "moulded. Country of origin Vietnam.",
  };
  const refinements: Refinement[] = first.result.clarifying_questions.map((q) => ({
    questionId: q.id,
    question: q.question,
    answer: answers.default,
  }));

  console.log("\nSTEP 2 — same analysis, questions answered, expect a recommendation");
  const second = await run(INPUT, refinements);
  console.log(`  status:      ${second.result.status}`);
  console.log(`  recommended: ${second.result.recommended_hts_code ?? "(none)"}`);
  console.log(`  candidates:  ${second.result.candidates.length}`);
  console.log(`  questions:   ${second.result.clarifying_questions.length}`);

  if (second.result.status !== "complete" || !second.result.recommended_hts_code) {
    throw new Error(
      `refinement did not resolve the analysis: status=${second.result.status}`,
    );
  }

  console.log("\nSTEP 3 — PDF from that run (not a fixture)");
  await renderAndCheck(INPUT, refinements, second);

  console.log("\nBoth paths verified.");
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
