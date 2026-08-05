/**
 * Run one real classification and print exactly what happened.
 *
 * The eval harness scores accuracy across a case file; this does something
 * narrower and, while the deployment is still failing, more useful: it runs a
 * single analysis against the live API and reports the mechanics — how many
 * tool steps, which tools, whether the structured-output grammar survived or
 * the prompt fallback engaged, what the run stopped on, and what came back.
 *
 * It exists because every failure so far has been diagnosed from a deployed
 * container, at fifteen minutes and several dollars a look, with the actual
 * cause arriving as a masked error or not at all. This is the same code path
 * the route drives — `classify()` — minus the session, the database and the
 * SSE stream, so a reproduction costs one command.
 *
 *   npx tsx scripts/dev/try-classify.ts --effort low \
 *     "stainless steel vacuum-insulated water bottle, 750ml"
 *
 *   npx tsx scripts/dev/try-classify.ts --mode PART_NUMBER --effort medium 3M-8210
 *
 * Start at --effort low. It exercises the same plumbing for a fraction of the
 * cost, and if the loop is broken it is broken there too.
 */

import fs from "node:fs";
import path from "node:path";
import { EFFORT_LEVELS } from "../../src/lib/config";
import { classify } from "../../src/lib/agent/classify";
import type { AnalysisMode } from "../../src/lib/agent/schema";

function loadDotEnvLocal(): void {
  const file = path.resolve(".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

interface Args {
  mode: AnalysisMode;
  effort: string | null;
  input: string;
}

function parseArgs(argv: string[]): Args {
  let mode: AnalysisMode = "DESCRIPTION";
  let effort: string | null = null;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mode") {
      mode = argv[++i] === "PART_NUMBER" ? "PART_NUMBER" : "DESCRIPTION";
    } else if (argv[i] === "--effort") {
      effort = argv[++i] ?? null;
    } else {
      rest.push(argv[i]);
    }
  }
  return { mode, effort, input: rest.join(" ").trim() };
}

async function main(): Promise<void> {
  loadDotEnvLocal();
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    throw new Error(
      "Give it something to classify, e.g.\n" +
        '  npx tsx scripts/dev/try-classify.ts --effort low "steel water bottle"',
    );
  }
  if (args.effort) {
    if (!(EFFORT_LEVELS as readonly string[]).includes(args.effort)) {
      throw new Error(`--effort must be one of ${EFFORT_LEVELS.join(", ")}.`);
    }
    // classify() reads this through config at call time.
    process.env.CLASSIFIER_EFFORT = args.effort;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Put it in the environment or .env.local.",
    );
  }

  const startedAt = Date.now();
  const toolCalls: string[] = [];
  let warnings = 0;
  let lastStatus = "";

  const elapsed = () =>
    `${String(Math.round((Date.now() - startedAt) / 1000)).padStart(4)}s`;

  console.log(`mode=${args.mode} effort=${process.env.CLASSIFIER_EFFORT ?? "max"}`);
  console.log(`input: ${args.input}\n`);

  for await (const event of classify({
    mode: args.mode,
    input: args.input,
    refinements: [],
  })) {
    switch (event.type) {
      case "status":
        lastStatus = event.message;
        console.log(`${elapsed()}  ${event.message}`);
        break;
      case "tool_use":
        toolCalls.push(event.name);
        console.log(`${elapsed()}  tool #${toolCalls.length} ${event.name} — ${event.summary}`);
        break;
      case "warning":
        warnings += 1;
        console.log(`${elapsed()}  WARNING ${event.message}`);
        break;
      case "error":
        console.log(`\n${elapsed()}  FAILED`);
        console.log(`  ${event.message}`);
        console.log(`\n  tool steps: ${toolCalls.length}`);
        console.log(`  tools used: ${[...new Set(toolCalls)].join(", ") || "none"}`);
        console.log(`  last status: ${lastStatus || "(none)"}`);
        process.exitCode = 1;
        return;
      case "done": {
        const { run } = event;
        console.log(`\n${elapsed()}  COMPLETE`);
        console.log(`  status:      ${run.result.status}`);
        console.log(`  recommended: ${run.result.recommended_hts_code ?? "(none)"}`);
        console.log(`  candidates:  ${run.result.candidates.length}`);
        console.log(`  tool steps:  ${toolCalls.length}`);
        console.log(`  tools used:  ${[...new Set(toolCalls)].join(", ") || "none"}`);
        console.log(`  warnings:    ${warnings}`);
        console.log(
          `  tokens:      ${run.usage.inputTokens} in / ${run.usage.outputTokens} out`,
        );
        console.log(`  verified:    ${run.verification.verifiedCodes.join(", ") || "none"}`);
        if (run.result.clarifying_questions.length) {
          console.log(`\n  CLARIFYING QUESTIONS (${run.result.clarifying_questions.length}):`);
          for (const q of run.result.clarifying_questions) {
            console.log(`    - ${q.question}`);
            console.log(`      why: ${q.why_it_matters}`);
            if (q.options.length) console.log(`      options: ${q.options.join(" | ")}`);
          }
        }
        if (run.result.researched_product) {
          const rp = run.result.researched_product;
          console.log(`\n  RESEARCHED PRODUCT:`);
          console.log(`    manufacturer: ${rp.manufacturer ?? "(not found)"}`);
          console.log(`    product:      ${rp.product_name ?? "(not found)"}`);
          console.log(`    materials:    ${rp.materials.join(", ") || "(none)"}`);
          console.log(`    summary:      ${rp.summary.slice(0, 160)}`);
          for (const v of rp.vendor_published_codes) {
            console.log(`    vendor code:  ${v.code} (${v.kind}) via ${v.source.slice(0, 60)}`);
          }
          console.log(`    sources:      ${rp.sources.length}`);
        }
        if (run.verification.rejectedCodes.length) {
          console.log("  REJECTED CODES (fabricated or absent from this revision):");
          for (const rejected of run.verification.rejectedCodes) {
            console.log(`    ${rejected.code} — ${rejected.reason}`);
          }
        }
        for (const candidate of run.result.candidates.slice(0, 3)) {
          console.log(
            `\n  #${candidate.rank} ${candidate.hts_code} ` +
              `(confidence ${candidate.confidence})`,
          );
          console.log(`     ${candidate.reasoning.justification.slice(0, 200)}`);
        }
        return;
      }
      default:
        break;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
