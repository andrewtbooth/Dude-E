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
 *   npx tsx scripts/dev/try-classify.ts --model claude-haiku-4-5 "steel water bottle"
 *
 * Start at --effort low. It exercises the same plumbing for a fraction of the
 * cost, and if the loop is broken it is broken there too.
 *
 * `--model claude-haiku-4-5` is cheaper still, but note it changes the request
 * shape rather than just the price: Haiku takes no effort level and no adaptive
 * thinking, so a green run there does not prove the production request works.
 * `--model claude-sonnet-5 --effort low` keeps the shape identical.
 */

import fs from "node:fs";
import path from "node:path";
import {
  CLASSIFIER_MODELS,
  EFFORT_LEVELS,
  config,
  type ClassifierModel,
} from "../../src/lib/config";
import { classify } from "../../src/lib/agent/classify";
import type { ProgressEvent } from "../../src/lib/agent/classify";
import { writeCassette } from "../../src/lib/agent/replay";
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
  model: string | null;
  record: string | null;
  replay: string | null;
  input: string;
}

function parseArgs(argv: string[]): Args {
  let mode: AnalysisMode = "DESCRIPTION";
  let effort: string | null = null;
  let model: string | null = null;
  let record: string | null = null;
  let replay: string | null = null;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mode") {
      mode = argv[++i] === "PART_NUMBER" ? "PART_NUMBER" : "DESCRIPTION";
    } else if (argv[i] === "--effort") {
      effort = argv[++i] ?? null;
    } else if (argv[i] === "--model") {
      model = argv[++i] ?? null;
    } else if (argv[i] === "--record") {
      record = argv[++i] ?? null;
    } else if (argv[i] === "--replay") {
      replay = argv[++i] ?? null;
    } else {
      rest.push(argv[i]);
    }
  }
  return { mode, effort, model, record, replay, input: rest.join(" ").trim() };
}

async function main(): Promise<void> {
  loadDotEnvLocal();
  const args = parseArgs(process.argv.slice(2));

  if (!args.input && !args.replay) {
    throw new Error(
      "Give it something to classify, e.g.\n" +
        '  npx tsx scripts/dev/try-classify.ts --effort low "steel water bottle"',
    );
  }
  // Both are read through config at call time, so setting the environment is
  // the whole of it. Set the model first: config validates effort against the
  // model's capabilities, and a model that takes no effort level rejects a
  // stale CLASSIFIER_EFFORT inherited from .env.local rather than ignoring it.
  if (args.model) {
    if (!(args.model in CLASSIFIER_MODELS)) {
      throw new Error(
        `--model must be one of ${Object.keys(CLASSIFIER_MODELS).join(", ")}.`,
      );
    }
    process.env.CLASSIFIER_MODEL = args.model;
    if (!CLASSIFIER_MODELS[args.model as ClassifierModel].effort) {
      delete process.env.CLASSIFIER_EFFORT;
    }
  }
  if (args.effort) {
    if (!(EFFORT_LEVELS as readonly string[]).includes(args.effort)) {
      throw new Error(`--effort must be one of ${EFFORT_LEVELS.join(", ")}.`);
    }
    process.env.CLASSIFIER_EFFORT = args.effort;
  }
  if (args.replay) process.env.CLASSIFIER_REPLAY = args.replay;

  // A replay needs no credentials — that is most of the point of it.
  if (!config.replayCassette && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Put it in the environment or .env.local.\n" +
        "To exercise the app without one, replay a recorded run:\n" +
        "  npx tsx scripts/dev/try-classify.ts --replay data/cassettes/<name>.json",
    );
  }

  const startedAt = Date.now();
  const toolCalls: string[] = [];
  const recorded: ProgressEvent[] = [];
  let warnings = 0;
  let lastStatus = "";

  const elapsed = () =>
    `${String(Math.round((Date.now() - startedAt) / 1000)).padStart(4)}s`;

  console.log(
    `mode=${args.mode} model=${config.model} effort=${config.effortLabel}`,
  );
  console.log(`input: ${args.input}\n`);

  for await (const event of classify({
    mode: args.mode,
    input: args.input,
    refinements: [],
  })) {
    if (args.record) recorded.push(event);
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
        // Recorded even on failure: a cassette of a run that went wrong is
        // exactly what you want when fixing how the app reports it.
        saveRecording(args, recorded);
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
          `  tokens:      ${run.usage.inputTokens} uncached in / ` +
            `${run.usage.outputTokens} out`,
        );
        // The lever that matters for spend on a tool loop. `cached` is the
        // history that would otherwise have been re-billed at full rate on
        // every iteration; if it is near zero on a multi-step run, caching is
        // not working and the run costs several times what it should.
        const prompt =
          run.usage.inputTokens +
          run.usage.cacheWriteTokens +
          run.usage.cacheReadTokens;
        console.log(
          `  cache:       ${run.usage.cacheWriteTokens} written / ` +
            `${run.usage.cacheReadTokens} read ` +
            `(${prompt ? Math.round((run.usage.cacheReadTokens / prompt) * 100) : 0}% ` +
            `of ${prompt} prompt tokens served from cache)`,
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
        saveRecording(args, recorded);
        return;
      }
      default:
        break;
    }
  }
}

function saveRecording(args: Args, events: ProgressEvent[]): void {
  if (!args.record) return;
  writeCassette(
    args.record,
    { mode: args.mode, input: args.input, refinements: 0 },
    events,
  );
  console.log(
    `\n  recorded ${events.length} event(s) to ${args.record}\n` +
      `  replay it for free: npx tsx scripts/dev/try-classify.ts --replay ${args.record}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
