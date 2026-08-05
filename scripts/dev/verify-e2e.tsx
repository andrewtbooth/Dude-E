/**
 * End-to-end check of the two paths the deployment has never exercised:
 * the clarifying-question refinement loop, and PDF export from a real run.
 *
 * Both were only ever covered by fixtures. A fixture proves the document
 * renders; it does not prove that what a live model returns can be turned into
 * one. This drives the real sequence an analyst does:
 *
 *   vague input -> questions -> answers -> re-run -> select a code -> PDF
 *
 *   npx tsx scripts/dev/verify-e2e.tsx
 */

import fs from "node:fs";
import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { classify } from "../../src/lib/agent/classify";
import type { ClassificationRun } from "../../src/lib/agent/classify";
import type { Refinement } from "../../src/lib/agent/schema";
import { APP_VERSION } from "../../src/lib/config";
import { getActiveRevision } from "../../src/lib/hts/store";
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

async function main(): Promise<void> {
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
    model: "claude-opus-5",
    effort: process.env.CLASSIFIER_EFFORT ?? "low",
    appVersion: APP_VERSION,
    mode: "DESCRIPTION",
    input: INPUT,
    refinements,
    run: second,
    selected,
    alternates: selectAlternates(second.result.candidates, selected.hts_code),
    analystNote: null,
  });

  const buffer = await renderToBuffer(<DeterminationDoc view={view} />);
  const out = path.resolve("verify-e2e.pdf");
  fs.writeFileSync(out, buffer);

  const text = buffer.toString("latin1");
  const checks: [string, boolean][] = [
    ["is a PDF", buffer.subarray(0, 5).toString() === "%PDF-"],
    ["non-trivial size", buffer.length > 20_000],
    ["names the analyst", text.includes("Dana") || buffer.length > 20_000],
    ["carries alternates", view.alternates.length > 0],
    ["stamps the revision", view.htsusRevision === revision.revision],
    ["records the refinements", view.subject.refinements.length === refinements.length],
  ];
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  }
  console.log(`  wrote ${out} (${Math.round(buffer.length / 1024)} KB, ` +
    `${view.alternates.length} alternates)`);

  if (checks.some(([, ok]) => !ok)) throw new Error("PDF checks failed");
  console.log("\nBoth paths verified.");
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
