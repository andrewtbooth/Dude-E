/**
 * Loading eval cases.
 *
 * Cases live in JSONL rather than TypeScript so a compliance analyst can add
 * one without touching code — which is the only way this dataset ever grows
 * past the seed, and the seed is not where the value is.
 */

import fs from "node:fs";
import type { EvalCase, EvalSource } from "./types";

const SOURCES: readonly EvalSource[] = ["cbp_ruling", "analyst", "eo_nomine"];

export interface LoadResult {
  cases: EvalCase[];
  /** Malformed lines, reported rather than skipped silently. */
  problems: string[];
}

export function parseCases(text: string): LoadResult {
  const cases: EvalCase[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) return;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      problems.push(`Line ${index + 1}: not valid JSON.`);
      return;
    }

    const row = raw as Partial<EvalCase>;
    const where = `Line ${index + 1}${row.id ? ` (${row.id})` : ""}`;

    if (!row.id) return void problems.push(`${where}: missing "id".`);
    if (seen.has(row.id)) return void problems.push(`${where}: duplicate id.`);
    if (!row.input) return void problems.push(`${where}: missing "input".`);
    if (!row.expected) return void problems.push(`${where}: missing "expected".`);

    if (row.expected.replace(/\D/g, "").length !== 10) {
      problems.push(
        `${where}: "expected" must be a 10-digit statistical reporting number, got "${row.expected}".`,
      );
      return;
    }
    if (!row.source || !SOURCES.includes(row.source)) {
      problems.push(`${where}: "source" must be one of ${SOURCES.join(", ")}.`);
      return;
    }
    // A ruling is the strongest claim a case can make, so it has to be checkable.
    if (row.source === "cbp_ruling" && !row.citation) {
      problems.push(`${where}: source "cbp_ruling" requires a "citation" ruling number.`);
      return;
    }

    seen.add(row.id);
    cases.push({
      id: row.id,
      mode: row.mode === "PART_NUMBER" ? "PART_NUMBER" : "DESCRIPTION",
      input: row.input,
      expected: row.expected,
      source: row.source,
      citation: row.citation,
      note: row.note,
      refinements: row.refinements ?? [],
    });
  });

  return { cases, problems };
}

export function loadCases(file: string): LoadResult {
  if (!fs.existsSync(file)) {
    return { cases: [], problems: [`No such case file: ${file}`] };
  }
  return parseCases(fs.readFileSync(file, "utf8"));
}

/**
 * How much the result set is worth trusting.
 *
 * A run made entirely of `eo_nomine` cases has shown that retrieval and the
 * GRI machinery work end to end. It has shown nothing about judgement on
 * contestable goods, which is what the tool is actually for, so the harness
 * says so rather than letting a green number speak for itself.
 */
export function describeProvenance(cases: readonly EvalCase[]): string {
  const counts = new Map<EvalSource, number>();
  for (const item of cases) {
    counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([source, n]) => `${n} ${source}`);
  const grounded = (counts.get("cbp_ruling") ?? 0) + (counts.get("analyst") ?? 0);

  if (grounded === 0) {
    return (
      `${parts.join(", ")}. Every case is constructed from the tariff's own ` +
      `wording, so this measures retrieval and GRI mechanics, NOT judgement on ` +
      `contestable goods. Add cases from CBP rulings or your own analysts' work ` +
      `before treating an accuracy figure here as an accuracy figure for the tool.`
    );
  }
  return `${parts.join(", ")}. ${grounded} case(s) carry real ground truth.`;
}
