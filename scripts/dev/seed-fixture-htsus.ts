/**
 * Build a tiny fixture HTSUS index into ./data/htsus so the app can be run
 * locally without network access to USITC.
 *
 *   npx tsx scripts/dev/seed-fixture-htsus.ts
 *
 * This is NOT a substitute for `npm run sync:htsus`. It contains four chapters
 * and is labelled as a fixture in the manifest so it cannot be mistaken for a
 * real revision in the UI or on an exported determination.
 */
import fs from "node:fs";
import path from "node:path";
import { parseUsitcRows } from "../../src/lib/hts/parse";
import {
  INDEX_FILENAME,
  MANIFEST_FILENAME,
  buildIndex,
} from "../../src/lib/hts/store";
import type { HtsusManifest } from "../../src/lib/hts/types";
import { FIXTURE_ROWS } from "../../src/test/htsus-fixture";

const root = path.resolve(process.env.HTSUS_DATA_DIR ?? "./data/htsus");
const dir = path.join(root, "fixture");
fs.mkdirSync(dir, { recursive: true });

const { lines } = parseUsitcRows(FIXTURE_ROWS);

const manifest: HtsusManifest = {
  revision: "FIXTURE — not a real HTSUS revision",
  publishedDate: null,
  retrievedAt: new Date().toISOString(),
  sourceUrl: "local fixture",
  sha256: "fixture",
  chapterCount: 4,
  lineCount: lines.length,
  reportableLineCount: lines.filter((line) => line.isReportable).length,
  noteCount: 3,
  scheduleBCount: 2,
  warnings: [
    "This is a four-chapter development fixture, not a synced tariff edition. Any determination produced against it is meaningless. Run `npm run sync:htsus` for real data.",
  ],
};

buildIndex(path.join(dir, INDEX_FILENAME), {
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
  path.join(dir, MANIFEST_FILENAME),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`Wrote development fixture index to ${dir}`);
console.log(`  ${lines.length} lines across 4 chapters — NOT real tariff data.`);
