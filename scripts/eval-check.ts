/**
 * Check an eval case file without spending anything.
 *
 *   npm run eval:check
 *   npm run eval:check -- --cases ./eval/team.local.jsonl
 *
 * `npm run eval` costs a full agent run per case, so the worst way to discover
 * that an expected code has a transposed digit is to pay for fifty runs and
 * read the miss as a finding about the model. Everything checkable is checked
 * here first, against the same snapshot the eval would verify against.
 *
 * Exit 1 on anything that would corrupt a result. Coverage notes are printed
 * either way — a case file can be perfectly valid and still not be worth
 * running, and that judgement belongs to whoever is about to spend the money.
 */

import { loadCases } from "../src/lib/eval/cases";
import { describeCoverage, preflightCases } from "../src/lib/eval/preflight";
import { getActiveRevision } from "../src/lib/hts/store";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Only the snapshot matters here, and it is on disk rather than in env.
}

function parseArgs(argv: string[]): { cases: string } {
  const args = { cases: "./eval/cases.seed.jsonl" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--cases") args.cases = argv[++i];
  }
  return args;
}

const { cases: file } = parseArgs(process.argv.slice(2));
const { cases, problems: parseProblems } = loadCases(file);

console.log(`Eval case check — ${file}`);
console.log("");

if (parseProblems.length > 0) {
  console.log("Malformed lines:");
  for (const problem of parseProblems) console.log(`  ${problem}`);
  console.log("");
}

if (cases.length === 0) {
  console.log("No usable cases.");
  process.exit(1);
}

let revision = "(no snapshot loaded)";
let partial = false;
try {
  const active = getActiveRevision();
  revision = active.revision;
  partial = active.isPartial;
} catch {
  // preflightCases reports this as an error on the first case.
}
console.log(`Checked against ${revision}.`);

// A partial snapshot cannot answer the question this script exists to ask.
// The dev fixture is four chapters, and it is the *newest* directory on a
// developer's machine, so it wins the store's resolution — which means this
// check would report a perfectly good case set as three-fifths broken and
// send someone hunting for typos that are not there. Refuse rather than
// report a falsehood confidently, which is the failure mode this whole
// application keeps being about.
if (partial) {
  console.log("");
  console.log(
    "Refusing: that snapshot is partial — a development fixture, not a synced\n" +
      "edition. Every code outside the chapters it happens to contain would be\n" +
      "reported as nonexistent. Run `npm run sync:htsus`, or point\n" +
      "HTSUS_DATA_DIR at a full snapshot.",
  );
  process.exit(1);
}
console.log("");

const result = preflightCases(cases);

const errors = result.problems.filter((p) => p.severity === "error");
const warnings = result.problems.filter((p) => p.severity === "warning");

for (const [heading, list] of [
  ["Errors — these would corrupt a result:", errors],
  ["Warnings:", warnings],
] as const) {
  if (list.length === 0) continue;
  console.log(heading);
  for (const problem of list) {
    console.log(`  ${problem.caseId}: ${problem.message}`);
  }
  console.log("");
}

console.log("Coverage:");
for (const line of describeCoverage(result, cases.length)) console.log(line);
console.log("");

if (errors.length > 0 || parseProblems.length > 0) {
  console.log(
    `Refusing: ${errors.length + parseProblems.length} problem(s). ` +
      `Fix these before running the eval — every one of them scores as a model ` +
      `failure it did not cause.`,
  );
  process.exit(1);
}

console.log(`${cases.length} case(s) ready.`);
