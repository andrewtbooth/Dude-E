import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUsitcRows } from "../lib/hts/parse";
import { formatScheduleB } from "../lib/hts/scheduleB";
import {
  INDEX_FILENAME,
  MANIFEST_FILENAME,
  buildIndex,
  resetStore,
} from "../lib/hts/store";
import type {
  HtsusManifest,
  ScheduleBLine,
  UsitcRawRow,
} from "../lib/hts/types";

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

function scheduleBLine(
  code: string,
  description: string,
  units: string[] = ["NO"],
): ScheduleBLine {
  return {
    code,
    htsNo: formatScheduleB(code),
    hs6: code.slice(0, 6),
    chapter: code.slice(0, 2),
    description,
    shortDescription: description.slice(0, 51),
    units,
    sitc: null,
    endUse: null,
    naics: null,
    isAgricultural: false,
    hiTech: null,
  };
}

/**
 * Shaped after the real divergence between the schedules at heading 9617.
 * HTSUS breaks 9617.00 out by capacity (over or under one litre); Schedule B
 * breaks the same subheading out by whether the article is complete or a part.
 * The result is that no Schedule B code shares all ten digits with
 * 9617.00.10.00 — which is the case the HS-6 join exists to handle, so the
 * fixture has to contain it.
 */
export const FIXTURE_SCHEDULE_B: ScheduleBLine[] = [
  scheduleBLine("8507600000", "LITHIUM ION BATTERIES"),
  scheduleBLine("9617002000", "FLASK AND OTHER VESSELS, COMPLETE WITH CASES"),
  scheduleBLine("9617006000", "PARTS OF VACUUM FLASKS ETC,EXCEPT GLASS INNERS"),
];

/**
 * One Chapter 99 note enumerating a fixture subheading, so the coverage path
 * is exercised. 7323.93.00 carries a footnote *and* appears here, which is the
 * case worth testing: the two linkages are independent and both must show.
 */
export const FIXTURE_CH99_COVERAGE = [
  {
    baseDigits: "73239300",
    noteRef: "19(k)",
    headings: ["9903.85.08"],
    excerpt:
      "(k) The rates of duty in heading 9903.85.08 apply to all entries of derivative aluminum products classifiable in the following HTSUS provisions: 7323.93.00; 7610.10.00.",
  },
];

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
    isPartial: true,
    noteCount: 3,
    scheduleBCount: FIXTURE_SCHEDULE_B.length,
    scheduleBEdition: "2026",
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
    scheduleB: FIXTURE_SCHEDULE_B,
    chapter99Coverage: FIXTURE_CH99_COVERAGE,
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
