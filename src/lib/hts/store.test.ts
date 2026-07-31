import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUsitcRows } from "./parse";
import {
  INDEX_FILENAME,
  MANIFEST_FILENAME,
  buildIndex,
  getActiveRevision,
  getAncestors,
  getChapter99Candidates,
  getGeneralRules,
  getIndexStats,
  getNotes,
  getScheduleB,
  getSubtree,
  lookupExact,
  resetStore,
  searchHts,
} from "./store";
import type { HtsusManifest, UsitcRawRow } from "./types";

const rows: UsitcRawRow[] = [
  {
    htsno: "8507",
    indent: "0",
    description: "Electric storage batteries; parts thereof:",
  },
  { htsno: "8507.60", indent: "1", description: "Lithium-ion batteries:" },
  {
    htsno: "8507.60.00",
    indent: "2",
    description: "Other",
    units: ["No.", "kg"],
    general: "3.4%",
    special: "Free (A+,AU,BH,CL)",
    other: "35%",
    footnotes: [{ value: "See 9903.88.03." }],
  },
  {
    htsno: "8507.60.00.10",
    indent: "3",
    description:
      "Of a kind used as the primary source of electrical power for electrically powered vehicles",
    units: ["No.", "kg"],
  },
  {
    htsno: "8507.60.00.20",
    indent: "3",
    description: "Other",
    units: ["No.", "kg"],
  },
  {
    htsno: "9617",
    indent: "0",
    description:
      "Vacuum flasks and other vacuum vessels, complete with cases; parts thereof:",
    units: ["No."],
    general: "7.2%",
    special: "Free (AU,BH,CL)",
    other: "55%",
  },
  {
    htsno: "9617.00.10",
    indent: "1",
    description: "Vacuum flasks and other vacuum vessels, complete with cases",
    units: ["No."],
    general: "7.2%",
    special: "Free (AU,BH,CL)",
    other: "55%",
  },
  {
    htsno: "9617.00.10.00",
    indent: "2",
    description: "Vacuum flasks and other vacuum vessels, complete with cases",
    units: ["No."],
  },
  {
    htsno: "9903.88.03",
    indent: "0",
    description:
      "Articles the product of China, as provided for in U.S. note 20(e) to this subchapter",
    general: "The duty provided in the applicable subheading + 25%",
  },
];

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "htsus-test-"));
  const revisionDir = path.join(tmpRoot, "2026-rev-13");
  fs.mkdirSync(revisionDir, { recursive: true });

  const { lines } = parseUsitcRows(rows);

  const manifest: HtsusManifest = {
    revision: "2026 HTS Revision 13",
    publishedDate: "2026-07-28",
    retrievedAt: "2026-07-31T00:00:00.000Z",
    sourceUrl: "https://hts.usitc.gov/reststop",
    sha256: "test-fixture",
    chapterCount: 3,
    lineCount: lines.length,
    reportableLineCount: lines.filter((l) => l.isReportable).length,
    noteCount: 2,
    scheduleBCount: 1,
    warnings: [],
  };

  buildIndex(path.join(revisionDir, INDEX_FILENAME), {
    lines,
    notes: [
      {
        kind: "general",
        ref: "GRI",
        title: "General Rules of Interpretation",
        body: "1. ... classification shall be determined according to the terms of the headings and any relative section or chapter notes ...",
      },
      {
        kind: "chapter",
        ref: "96",
        title: "Chapter 96 Notes",
        body: "This chapter does not cover parts of general use of base metal.",
      },
    ],
    scheduleB: [
      {
        hts10: "8507600020",
        scheduleB: "8507.60.0000",
        description: "Lithium-ion storage batteries",
      },
    ],
    manifest,
  });

  fs.writeFileSync(
    path.join(revisionDir, MANIFEST_FILENAME),
    JSON.stringify(manifest, null, 2),
  );

  process.env.HTSUS_DATA_DIR = tmpRoot;
  resetStore();
});

afterAll(() => {
  resetStore();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("HTSUS index", () => {
  it("exposes the revision stamp read from the manifest, not hardcoded", () => {
    const revision = getActiveRevision();
    expect(revision.revision).toBe("2026 HTS Revision 13");
    expect(revision.publishedDate).toBe("2026-07-28");
  });

  it("reports index statistics", () => {
    const stats = getIndexStats();
    expect(stats.lineCount).toBe(9);
    expect(stats.reportableLineCount).toBe(3);
    expect(stats.noteCount).toBe(2);
    expect(stats.scheduleBCount).toBe(1);
  });

  it("finds lines by natural-language query", () => {
    const hits = searchHts("lithium ion battery");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.htsNo.startsWith("8507.60"))).toBe(true);
  });

  it("does not choke on punctuation the agent might type", () => {
    expect(() => searchHts('lithium-ion (18650) "cells" AND OR')).not.toThrow();
    expect(() => searchHts("***")).not.toThrow();
    expect(searchHts("***")).toEqual([]);
  });

  it("filters to reportable 10-digit lines on request", () => {
    const hits = searchHts("vacuum flask", { reportableOnly: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.isReportable)).toBe(true);
    expect(hits.every((h) => h.htsNo.replace(/\D/g, "").length === 10)).toBe(
      true,
    );
  });

  it("filters by chapter", () => {
    const hits = searchHts("other", { chapter: "96" });
    expect(hits.every((h) => h.htsNo.startsWith("96"))).toBe(true);
  });

  it("looks up an exact code regardless of formatting", () => {
    expect(lookupExact("8507.60.00.20")?.htsNo).toBe("8507.60.00.20");
    expect(lookupExact("8507600020")?.htsNo).toBe("8507.60.00.20");
  });

  it("returns null for a code that does not exist in this revision", () => {
    // This is the anti-fabrication check the API layer depends on.
    expect(lookupExact("8507.60.00.99")).toBeNull();
    expect(lookupExact("9999.99.99.99")).toBeNull();
    expect(lookupExact("")).toBeNull();
  });

  it("returns a subtree in document order", () => {
    const subtree = getSubtree("8507.60");
    expect(subtree.map((l) => l.htsNo)).toEqual([
      "8507.60",
      "8507.60.00",
      "8507.60.00.10",
      "8507.60.00.20",
    ]);
  });

  it("returns the ancestor chain outermost first", () => {
    const ancestors = getAncestors("8507.60.00.20");
    expect(ancestors.map((l) => l.htsNo)).toEqual([
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

  it("maps a 10-digit HTS number to Schedule B", () => {
    expect(getScheduleB("8507.60.00.20")).toEqual([
      {
        hts10: "8507600020",
        scheduleB: "8507.60.0000",
        description: "Lithium-ion storage batteries",
      },
    ]);
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

  it("returns no Chapter 99 duties for an unrelated code", () => {
    expect(getChapter99Candidates("9617.00.10.00")).toEqual([]);
  });
});
