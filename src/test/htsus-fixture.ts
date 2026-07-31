import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUsitcRows } from "../lib/hts/parse";
import {
  INDEX_FILENAME,
  MANIFEST_FILENAME,
  buildIndex,
  resetStore,
} from "../lib/hts/store";
import type { HtsusManifest, UsitcRawRow } from "../lib/hts/types";

/**
 * A small but genuinely awkward slice of the tariff, used across the data-layer
 * and agent tests.
 *
 * It deliberately includes the vacuum-flask case (Chapter 96 vessel vs.
 * Chapter 73 steel article), which is the classic GRI 1 tension: two headings
 * both look plausible until you read the notes.
 */
export const FIXTURE_ROWS: UsitcRawRow[] = [
  // --- Chapter 73: articles of iron or steel ---
  {
    htsno: "7323",
    indent: "0",
    description:
      "Table, kitchen or other household articles and parts thereof, of iron or steel:",
  },
  { htsno: "7323.93", indent: "1", description: "Of stainless steel:" },
  {
    htsno: "7323.93.00",
    indent: "2",
    description: "Other",
    units: ["No.", "kg"],
    general: "2%",
    special: "Free (A,AU,BH,CL,CO,D,E,IL,JO,KR,MA,OM,P,PA,PE,S,SG)",
    other: "40%",
    footnotes: [{ value: "See 9903.88.03." }],
  },
  {
    htsno: "7323.93.00.80",
    indent: "3",
    description: "Other",
    units: ["No.", "kg"],
  },

  // --- Chapter 85: electric storage batteries ---
  {
    htsno: "8507",
    indent: "0",
    description:
      "Electric storage batteries, including separators therefor; parts thereof:",
  },
  { htsno: "8507.60", indent: "1", description: "Lithium-ion batteries:" },
  {
    htsno: "8507.60.00",
    indent: "2",
    description: "Other",
    units: ["No.", "kg"],
    general: "3.4%",
    special: "Free (A+,AU,BH,CL,CO,D,E,IL,JO,KR,MA,OM,P,PA,PE,S,SG)",
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

  // --- Chapter 96: vacuum vessels ---
  {
    htsno: "9617",
    indent: "0",
    description:
      "Vacuum flasks and other vacuum vessels, complete with cases; parts thereof other than glass inners:",
    units: [],
  },
  {
    htsno: "9617.00.10",
    indent: "1",
    description: "Vacuum flasks and other vacuum vessels, complete with cases",
    units: ["No."],
    general: "7.2%",
    special: "Free (AU,BH,CL,CO,D,E,IL,JO,KR,MA,OM,P,PA,PE,S,SG)",
    other: "55%",
  },
  {
    htsno: "9617.00.10.00",
    indent: "2",
    description: "Vacuum flasks and other vacuum vessels, complete with cases",
    units: ["No."],
  },

  // --- Chapter 99: Section 301 ---
  {
    htsno: "9903.88.03",
    indent: "0",
    description:
      "Articles the product of China, as provided for in U.S. note 20(e) to this subchapter",
    general: "The duty provided in the applicable subheading + 25%",
  },
];

export const FIXTURE_REVISION = "2026 HTS Revision 13";

let fixtureRoot: string | null = null;
let previousDataDir: string | undefined;

/** Build a temporary HTSUS index and point the store at it. */
export function setupFixtureIndex(): string {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "htsus-fixture-"));
  const revisionDir = path.join(fixtureRoot, "2026-hts-revision-13");
  fs.mkdirSync(revisionDir, { recursive: true });

  const { lines } = parseUsitcRows(FIXTURE_ROWS);

  const manifest: HtsusManifest = {
    revision: FIXTURE_REVISION,
    publishedDate: "2026-07-28",
    retrievedAt: "2026-07-31T00:00:00.000Z",
    sourceUrl: "https://hts.usitc.gov/reststop",
    sha256: "fixture",
    chapterCount: 4,
    lineCount: lines.length,
    reportableLineCount: lines.filter((line) => line.isReportable).length,
    noteCount: 3,
    scheduleBCount: 2,
    warnings: [],
  };

  buildIndex(path.join(revisionDir, INDEX_FILENAME), {
    lines,
    notes: [
      {
        kind: "general",
        ref: "GRI",
        title: "General Rules of Interpretation",
        body: "1. ... for legal purposes, classification shall be determined according to the terms of the headings and any relative section or chapter notes ...",
      },
      {
        kind: "chapter",
        ref: "73",
        title: "Chapter 73 Notes",
        body: "For the purposes of this chapter, the expression 'tubes and pipes' means ...",
      },
      {
        kind: "chapter",
        ref: "96",
        title: "Chapter 96 Notes",
        body: "This chapter does not cover parts of general use of base metal (Section XV).",
      },
    ],
    scheduleB: [
      {
        hts10: "8507600020",
        scheduleB: "8507.60.0000",
        description: "Lithium-ion storage batteries",
      },
      {
        hts10: "9617001000",
        scheduleB: "9617.00.0000",
        description: "Vacuum flasks and other vacuum vessels",
      },
    ],
    manifest,
  });

  fs.writeFileSync(
    path.join(revisionDir, MANIFEST_FILENAME),
    JSON.stringify(manifest, null, 2),
  );

  previousDataDir = process.env.HTSUS_DATA_DIR;
  process.env.HTSUS_DATA_DIR = fixtureRoot;
  resetStore();

  return fixtureRoot;
}

export function teardownFixtureIndex(): void {
  resetStore();
  if (fixtureRoot) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
  if (previousDataDir === undefined) delete process.env.HTSUS_DATA_DIR;
  else process.env.HTSUS_DATA_DIR = previousDataDir;
}
