/**
 * Measure classification accuracy and confidence calibration.
 *
 *   npm run eval                                   # the committed seed set
 *   npm run eval -- --cases ./eval/team.local.jsonl
 *   npm run eval -- --effort high --out ./eval/runs
 *
 * This costs real money — every case is a full agent run at the configured
 * effort — so it never runs as part of the test suite and is not wired into
 * CI. The scoring it depends on is pure and unit-tested separately, so the
 * harness itself is verifiable without spending anything.
 *
 * ## Reading the output
 *
 * The headline number is exact 10-digit accuracy, but the more useful lines
 * are underneath it: how often the answer was right to the 8-digit rate line
 * (duty correct, suffix wrong), whether the right code was offered at all, and
 * whether stated confidence tracks being right. A model that is wrong while
 * claiming 95% is worse for an analyst than one that is wrong and says so.
 */

import fs from "node:fs";
import path from "node:path";
import { classify } from "../src/lib/agent/classify";
import { loadCases, describeProvenance } from "../src/lib/eval/cases";
import { formatReport, scoreEval } from "../src/lib/eval/score";
import type { EvalCase, EvalOutcome } from "../src/lib/eval/types";
import { EFFORT_LEVELS } from "../src/lib/config";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Defaults are fine; the API key check below is the one that matters.
}

interface Args {
  cases: string;
  out: string;
  effort?: string;
  only?: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cases: "./eval/cases.seed.jsonl", out: "./eval/runs" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--cases") args.cases = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--effort") args.effort = argv[++i];
    else if (flag === "--only") args.only = (argv[++i] ?? "").split(",").map((s) => s.trim());
  }
  return args;
}

/** Run one case to completion, collapsing the progress stream to an outcome. */
async function runCase(item: EvalCase): Promise<EvalOutcome> {
  const startedAt = Date.now();
  const base: EvalOutcome = {
    caseId: item.id,
    expected: item.expected,
    predicted: null,
    candidates: [],
    confidence: null,
    status: "failed",
    rejectedCodes: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  try {
    for await (const event of classify({
      mode: item.mode,
      input: item.input,
      // A case's answers are pre-supplied, so there is no question id to echo
      // back; the model only ever reads the question and answer text.
      refinements: (item.refinements ?? []).map((r, index) => ({
        questionId: `case-${item.id}-${index}`,
        question: r.question,
        answer: r.answer,
      })),
    })) {
      if (event.type === "error") {
        return { ...base, error: event.message, durationMs: Date.now() - startedAt };
      }
      if (event.type !== "done") continue;

      const { run } = event;
      const ranked = [...run.result.candidates].sort((a, b) => a.rank - b.rank);
      return {
        ...base,
        // What the analyst is actually shown as the pick, which is the thing
        // being measured — not the best candidate anywhere in the list.
        predicted: run.result.recommended_hts_code ?? ranked[0]?.hts_code ?? null,
        candidates: ranked.map((c) => ({ code: c.hts_code, confidence: c.confidence })),
        confidence: ranked[0]?.confidence ?? null,
        status: run.result.status === "complete" ? "complete" : "needs_more_info",
        rejectedCodes: run.verification.rejectedCodes.length,
        durationMs: Date.now() - startedAt,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
      };
    }
    return { ...base, error: "run ended with no result", durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.effort) {
    if (!(EFFORT_LEVELS as readonly string[]).includes(args.effort)) {
      throw new Error(
        `--effort must be one of ${EFFORT_LEVELS.join(", ")} (got "${args.effort}").`,
      );
    }
    // classify() reads this through config at call time.
    process.env.CLASSIFIER_EFFORT = args.effort;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. This harness runs real classifications;\n" +
        "there is no offline mode, because a mocked run would measure the mock.",
    );
  }

  const { cases: all, problems } = loadCases(path.resolve(args.cases));
  for (const problem of problems) console.warn(`  ! ${problem}`);
  if (all.length === 0) {
    throw new Error(`No usable cases in ${args.cases}.`);
  }

  const cases = args.only ? all.filter((c) => args.only?.includes(c.id)) : all;
  if (cases.length === 0) throw new Error(`--only matched no cases.`);

  const effort = process.env.CLASSIFIER_EFFORT ?? "max";
  console.log(`Classification eval`);
  console.log(`  cases:  ${cases.length} from ${args.cases}`);
  console.log(`  effort: ${effort}`);
  console.log(`  ground truth: ${describeProvenance(cases)}`);
  console.log("");
  console.log(
    `Each case is a full agent run and takes minutes at high effort. ` +
      `Expect this to cost real money.`,
  );
  console.log("");

  const outcomes: EvalOutcome[] = [];
  for (const [index, item] of cases.entries()) {
    process.stdout.write(`  [${index + 1}/${cases.length}] ${item.id} … `);
    const outcome = await runCase(item);
    outcomes.push(outcome);
    const verdict =
      outcome.predicted === null
        ? `failed: ${outcome.error ?? "unknown"}`
        : `${outcome.predicted} (expected ${item.expected})`;
    console.log(`${verdict}  ${(outcome.durationMs / 1000).toFixed(0)}s`);
  }

  const report = scoreEval(cases, outcomes);
  const text = formatReport(report, `effort=${effort}, ${cases.length} cases`);
  console.log("");
  console.log(text);

  fs.mkdirSync(path.resolve(args.out), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(path.resolve(args.out), `eval-${effort}-${stamp}.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ effort, cases, outcomes, report }, null, 2)}\n`,
  );
  console.log("");
  console.log(`Wrote ${file}`);
  console.log(
    `Sweep effort by re-running with --effort high|xhigh|max and comparing ` +
      `exact accuracy against wall clock and tokens.`,
  );
}

if (/eval\.ts$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
