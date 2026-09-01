/**
 * The check that protects a metered run.
 *
 * `npm run eval` costs a full agent run per case. The worst way to discover
 * that an expected code has a transposed digit is to pay for fifty runs and
 * then read the miss as a finding about the model — the number is wrong, the
 * conclusion drawn from it is wrong, and nothing in the report says so.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupFixtureIndex, teardownFixtureIndex } from "../../test/htsus-fixture";
import { describeCoverage, preflightCases } from "./preflight";
import type { EvalCase } from "./types";

beforeAll(() => setupFixtureIndex());
afterAll(() => teardownFixtureIndex());

const base = {
  mode: "DESCRIPTION" as const,
  input: "A thing.",
  source: "eo_nomine" as const,
};

const caseFor = (id: string, expected: string, extra: Partial<EvalCase> = {}) =>
  ({ ...base, id, expected, ...extra }) as EvalCase;

describe("preflightCases", () => {
  it("passes a code that exists and is declarable", () => {
    const { problems } = preflightCases([caseFor("ok", "8507.60.00.20")]);
    expect(problems).toEqual([]);
  });

  it("catches an expected code that does not exist", () => {
    const { problems } = preflightCases([caseFor("typo", "8507.60.00.99")]);
    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe("error");
    expect(problems[0].message).toMatch(/does not exist/);
  });

  it("catches an expected code the tool is designed never to answer", () => {
    // 8507.60.00 is a rate line with statistical breakouts beneath it, so
    // verification drops it as a candidate. A case expecting it has written
    // down an answer no run can give — a broken case, not a model failure.
    const { problems } = preflightCases([caseFor("rate-line", "8507.60.00")]);
    expect(problems[0].message).toMatch(/not a declarable line/);
  });

  it("catches a Chapter 98 expectation", () => {
    // Claimed alongside a classification, never as one.
    const { problems } = preflightCases([caseFor("tib", "9813.00.20")]);
    expect(problems[0].message).toMatch(/Chapter 98/);
  });

  it("counts provenance, chapters and tags", () => {
    const result = preflightCases([
      caseFor("a", "8507.60.00.20", { tags: ["residual"] }),
      caseFor("b", "9617.00.10.00", { source: "analyst", tags: ["residual", "parts"] }),
    ]);

    expect(result.grounded).toBe(1);
    expect(result.sources.get("eo_nomine")).toBe(1);
    expect(result.sources.get("analyst")).toBe(1);
    expect(result.chapters.get("85")).toBe(1);
    expect(result.chapters.get("96")).toBe(1);
    expect(result.tags.get("residual")).toBe(2);
  });
});

describe("describeCoverage", () => {
  it("says plainly when nothing carries real ground truth", () => {
    // The failure this guards is a green number over a set of cases built from
    // the tariff's own wording being read as an accuracy figure for the tool.
    const result = preflightCases([caseFor("a", "8507.60.00.20")]);
    const text = describeCoverage(result, 1).join(" ");
    expect(text).toMatch(/Nothing here carries real ground truth/);
    expect(text).toMatch(/says nothing about judgement on contestable goods/);
  });

  it("stops saying it once a grounded case is present", () => {
    const result = preflightCases([
      caseFor("a", "8507.60.00.20", { source: "analyst" }),
    ]);
    expect(describeCoverage(result, 1).join(" ")).not.toMatch(
      /Nothing here carries real ground truth/,
    );
  });

  it("warns that a small set cannot support a calibration curve", () => {
    const result = preflightCases([caseFor("a", "8507.60.00.20")]);
    expect(describeCoverage(result, 9).join(" ")).toMatch(/too few/);
  });
});
