import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIXTURE_REVISION,
  setupFixtureIndex,
  teardownFixtureIndex,
} from "../../test/htsus-fixture";
import {
  getActiveRevision,
  getAncestors,
  getChapter99Candidates,
  getGeneralRules,
  getIndexStats,
  getNotes,
  getScheduleB,
  getSubtree,
  lookupExact,
  searchHts,
} from "./store";

beforeAll(() => setupFixtureIndex());
afterAll(() => teardownFixtureIndex());

describe("HTSUS index", () => {
  it("exposes the revision stamp read from the manifest, not hardcoded", () => {
    const revision = getActiveRevision();
    expect(revision.revision).toBe(FIXTURE_REVISION);
    expect(revision.publishedDate).toBe("2026-07-28");
  });

  it("reports index statistics", () => {
    const stats = getIndexStats();
    expect(stats.lineCount).toBe(13);
    expect(stats.reportableLineCount).toBe(4);
    expect(stats.noteCount).toBe(3);
    expect(stats.scheduleBCount).toBe(2);
  });

  it("finds lines by natural-language query", () => {
    const hits = searchHts("lithium ion battery");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.htsNo.startsWith("8507.60"))).toBe(true);
  });

  it("does not choke on punctuation the agent might type", () => {
    expect(() => searchHts('lithium-ion (18650) "cells" AND OR')).not.toThrow();
    expect(searchHts("***")).toEqual([]);
  });

  it("filters to reportable 10-digit lines on request", () => {
    const hits = searchHts("vacuum flask", { reportableOnly: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.isReportable)).toBe(true);
    expect(
      hits.every((hit) => hit.htsNo.replace(/\D/g, "").length === 10),
    ).toBe(true);
  });

  it("filters by chapter", () => {
    const hits = searchHts("other", { chapter: "96" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.htsNo.startsWith("96"))).toBe(true);
  });

  it("looks up an exact code regardless of formatting", () => {
    expect(lookupExact("8507.60.00.20")?.htsNo).toBe("8507.60.00.20");
    expect(lookupExact("8507600020")?.htsNo).toBe("8507.60.00.20");
  });

  it("returns null for a code that does not exist in this revision", () => {
    // This is what the anti-fabrication check in verifyAgainstTariff relies on.
    expect(lookupExact("8507.60.00.99")).toBeNull();
    expect(lookupExact("9999.99.99.99")).toBeNull();
    expect(lookupExact("")).toBeNull();
  });

  it("returns a subtree in document order", () => {
    expect(getSubtree("8507.60").map((line) => line.htsNo)).toEqual([
      "8507.60",
      "8507.60.00",
      "8507.60.00.10",
      "8507.60.00.20",
    ]);
  });

  it("returns the ancestor chain outermost first", () => {
    expect(getAncestors("8507.60.00.20").map((line) => line.htsNo)).toEqual([
      "8507",
      "8507.60",
      "8507.60.00",
    ]);
  });

  it("serves the General Rules of Interpretation verbatim", () => {
    const rules = getGeneralRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].body).toMatch(/terms of the headings/);
  });

  it("serves chapter notes by reference", () => {
    const notes = getNotes("chapter", "96");
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toMatch(/parts of general use/);
  });

  it("returns nothing for a section with no stored notes", () => {
    expect(getNotes("section", "XVI")).toEqual([]);
  });

  it("maps a 10-digit HTS number to Schedule B", () => {
    expect(getScheduleB("8507.60.00.20")).toEqual([
      {
        hts10: "8507600020",
        scheduleB: "8507.60.0000",
        description: "Lithium-ion storage batteries",
      },
    ]);
  });

  it("returns no Schedule B mapping for an unmapped code", () => {
    expect(getScheduleB("7323.93.00.80")).toEqual([]);
  });

  it("finds Chapter 99 duties via footnotes on ancestor rate lines", () => {
    // The "See 9903.88.03." footnote lives on the 8-digit line, but the
    // analyst classifies to the 10-digit line — the lookup has to walk up.
    const entries = getChapter99Candidates("8507.60.00.20");
    expect(entries).toHaveLength(1);
    expect(entries[0].htsNo).toBe("9903.88.03");
    expect(entries[0].program).toBe("Section 301 (China)");
    expect(entries[0].additionalDuty).toMatch(/25%/);
  });

  it("finds the same provision from a different chapter's footnote", () => {
    const entries = getChapter99Candidates("7323.93.00.80");
    expect(entries.map((entry) => entry.htsNo)).toEqual(["9903.88.03"]);
  });

  it("returns no Chapter 99 duties for an unrelated code", () => {
    expect(getChapter99Candidates("9617.00.10.00")).toEqual([]);
  });
});
