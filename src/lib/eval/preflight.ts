import { lookupExact } from "../hts/store";
import type { EvalCase } from "./types";

/**
 * Check a case file against the loaded tariff before spending anything on it.
 *
 * `parseCases` checks that `expected` is ten digits. It does not check that
 * those ten digits are a code — so a transposed pair, or a suffix that moved
 * between revisions, loads cleanly, scores as a miss on every run, and is
 * indistinguishable in the report from the model getting it wrong. You find out
 * after paying for the run, and the thing you conclude from it is false.
 *
 * The whole check is free: the answer is in the snapshot the eval would verify
 * against anyway.
 *
 * A case whose expected code is not *declarable* is worth catching for a
 * separate reason. `verifyAgainstTariff` drops a candidate that is not the
 * deepest published line, so a case expecting a rate line has written down an
 * answer the tool is designed never to give. That is a broken case, not a
 * finding about the model.
 */
export type CaseProblem = {
  caseId: string;
  severity: "error" | "warning";
  message: string;
};

export interface PreflightResult {
  problems: CaseProblem[];
  /** Cases per chapter, so a set that only exercises three chapters says so. */
  chapters: Map<string, number>;
  sources: Map<string, number>;
  tags: Map<string, number>;
  /** Cases carrying real ground truth — a ruling, or an analyst's own work. */
  grounded: number;
}

export function preflightCases(cases: readonly EvalCase[]): PreflightResult {
  const problems: CaseProblem[] = [];
  const chapters = new Map<string, number>();
  const sources = new Map<string, number>();
  const tags = new Map<string, number>();
  let grounded = 0;

  const bump = (map: Map<string, number>, key: string) =>
    map.set(key, (map.get(key) ?? 0) + 1);

  for (const item of cases) {
    bump(sources, item.source);
    for (const tag of item.tags ?? []) bump(tags, tag);
    if (item.source === "cbp_ruling" || item.source === "analyst") grounded += 1;

    const digits = item.expected.replace(/\D/g, "");
    bump(chapters, digits.slice(0, 2));

    let line: ReturnType<typeof lookupExact> = null;
    try {
      line = lookupExact(item.expected);
    } catch {
      problems.push({
        caseId: item.id,
        severity: "error",
        message:
          "No tariff snapshot is loaded, so no expected code can be checked. " +
          "Run `npm run sync:htsus` first.",
      });
      break;
    }

    if (!line) {
      problems.push({
        caseId: item.id,
        severity: "error",
        message:
          `Expected code ${item.expected} does not exist in this revision. ` +
          `A typo here scores as a miss on every run and reads as the model ` +
          `being wrong.`,
      });
      continue;
    }

    // Chapter first, because it is the more specific answer to "why can this
    // never be returned". A secondary-chapter provision is also not declarable,
    // so testing reportability first would answer every Chapter 98 case with
    // the generic message and send someone looking for a deeper suffix that
    // does not exist and would not help.
    if (line.chapter === "98" || line.chapter === "99") {
      problems.push({
        caseId: item.id,
        severity: "error",
        message:
          `Expected code ${item.expected} is a Chapter ${line.chapter} ` +
          `provision. Those are claimed alongside a classification, never as ` +
          `one, so no run can return it as the answer.`,
      });
      continue;
    }

    if (!line.isReportable) {
      problems.push({
        caseId: item.id,
        severity: "error",
        message:
          `Expected code ${item.expected} exists but is not a declarable line ` +
          `— verification drops candidates that are not the deepest published ` +
          `code, so the tool is designed never to answer this. Use the ` +
          `statistical breakout beneath it.`,
      });
    }
  }

  return { problems, chapters, sources, tags, grounded };
}

/**
 * What the set does and does not cover.
 *
 * Separate from the problem list because a case set can be entirely valid and
 * still not be worth running. Every figure here is about what an accuracy
 * number from this file would be entitled to claim.
 */
export function describeCoverage(result: PreflightResult, total: number): string[] {
  const lines: string[] = [];
  const list = (map: Map<string, number>) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, n]) => `${key} (${n})`)
      .join(", ");

  lines.push(`  cases:     ${total}`);
  lines.push(`  sources:   ${list(result.sources) || "none"}`);
  lines.push(`  chapters:  ${result.chapters.size} — ${list(result.chapters)}`);
  lines.push(`  tags:      ${list(result.tags) || "none"}`);

  if (result.grounded === 0) {
    lines.push("");
    lines.push(
      "  Nothing here carries real ground truth. Every expected answer is read",
    );
    lines.push(
      "  off the tariff's own wording, which measures retrieval and GRI mechanics",
    );
    lines.push(
      "  and says nothing about judgement on contestable goods — the thing the",
    );
    lines.push("  tool is actually for.");
  }

  if (total < 30) {
    lines.push("");
    lines.push(
      `  ${total} cases is too few to read a calibration curve from. A band with`,
    );
    lines.push(
      "  three cases in it reports 0%, 33%, 67% or 100% accuracy and nothing",
    );
    lines.push("  between, so ECE over a small set mostly measures rounding.");
  }

  return lines;
}
