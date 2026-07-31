/**
 * Build the tariff index from a file you downloaded yourself.
 *
 *   npm run import:htsus -- --file ./data/raw/hts.json --revision "2026 HTS Revision 13"
 *   npm run import:htsus -- --dir  ./data/raw          --revision "2026 HTS Revision 13"
 *
 * Why this exists
 * ---------------
 * `sync:htsus` needs outbound access to hts.usitc.gov, which plenty of
 * corporate networks and sandboxed environments do not permit. The export at
 * https://hts.usitc.gov/export produces the same data as a browser download
 * (set the range 0101 to 9999 for the whole schedule), and a browser download
 * from a laptop is rarely blocked by anything.
 *
 * The result is a real index built from real published data, so code
 * verification, duty rates and the version stamp all work exactly as they do
 * after a network sync. The one thing a file export does not carry is the
 * Section and Chapter Notes, which USITC publishes as PDF — see the warning
 * this script records, and `hts_notes`, which reports their absence honestly
 * rather than letting the model read it as "no notes exist".
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseUsitcCsv } from "../src/lib/hts/csv";
import { parseUsitcRows } from "../src/lib/hts/parse";
import {
  INDEX_FILENAME,
  MANIFEST_FILENAME,
  buildIndex,
} from "../src/lib/hts/store";
import type {
  HtsLine,
  HtsusManifest,
  ScheduleBEntry,
  UsitcRawRow,
} from "../src/lib/hts/types";
import { parseConcordance } from "./sync-htsus";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Defaults below are fine without one.
}

const DATA_DIR = path.resolve(process.env.HTSUS_DATA_DIR ?? "./data/htsus");

const warnings: string[] = [];

function warn(message: string): void {
  warnings.push(message);
  console.warn(`  ! ${message}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  file?: string;
  dir?: string;
  revision?: string;
  scheduleB?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--file") args.file = argv[++i];
    else if (flag === "--dir") args.dir = argv[++i];
    else if (flag === "--revision") args.revision = argv[++i];
    else if (flag === "--schedule-b") args.scheduleB = argv[++i];
  }
  return args;
}

const USAGE = [
  "Build the tariff index from a downloaded HTS export.",
  "",
  "  1. Open https://hts.usitc.gov/export",
  "  2. Range 0101 to 9999, format JSON (CSV also works)",
  "  3. Save the file, then:",
  "",
  '     npm run import:htsus -- --file ./data/raw/hts.json --revision "2026 HTS Revision 13"',
  "",
  "Options",
  "  --file <path>        A single .json or .csv export",
  "  --dir <path>         A directory of exports (e.g. one file per chapter)",
  "  --revision <label>   Required. Exactly as USITC names it, e.g.",
  '                       "2026 HTS Revision 13". This is stamped onto every',
  "                       determination, so it must be the truth.",
  "  --schedule-b <path>  Optional Census HTS-to-Schedule B concordance file",
].join("\n");

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function collectInputFiles(args: Args): string[] {
  if (args.file) {
    const resolved = path.resolve(args.file);
    if (!fs.existsSync(resolved)) {
      throw new Error(`No such file: ${resolved}`);
    }
    return [resolved];
  }

  const dir = path.resolve(args.dir ?? "./data/raw");
  if (!fs.existsSync(dir)) {
    throw new Error(
      `No such directory: ${dir}\n\n${USAGE}`,
    );
  }

  const files = fs
    .readdirSync(dir)
    .filter((name) => /\.(json|csv)$/i.test(name))
    .sort()
    .map((name) => path.join(dir, name));

  if (files.length === 0) {
    throw new Error(`No .json or .csv files found in ${dir}\n\n${USAGE}`);
  }
  return files;
}

function readRows(file: string): UsitcRawRow[] {
  const body = fs.readFileSync(file, "utf8");
  const name = path.basename(file);

  if (/\.csv$/i.test(file)) {
    const { rows, unmappedHeaders, missingColumns } = parseUsitcCsv(body);
    if (missingColumns.length > 0) {
      warn(
        `${name}: missing required column(s) ${missingColumns.join(", ")}. ` +
          `Re-export from hts.usitc.gov/export without altering the columns.`,
      );
      return [];
    }
    if (unmappedHeaders.length > 0) {
      warn(`${name}: ignored unrecognised column(s) ${unmappedHeaders.join(", ")}.`);
    }
    return rows;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    warn(`${name}: not valid JSON. First 200 chars: ${body.slice(0, 200)}`);
    return [];
  }

  if (Array.isArray(parsed)) return parsed as UsitcRawRow[];

  // Some exports wrap the array; accept the common shapes rather than making
  // the user reshape the file by hand.
  if (parsed && typeof parsed === "object") {
    for (const key of ["data", "results", "rows", "items"]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as UsitcRawRow[];
    }
  }

  warn(
    `${name}: expected a JSON array of tariff rows, got ${typeof parsed}. ` +
      `First 200 chars: ${body.slice(0, 200)}`,
  );
  return [];
}

function slugify(revision: string): string {
  return revision.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.revision || args.revision.trim() === "") {
    throw new Error(
      "--revision is required.\n\n" +
        "The revision label is stamped onto every determination and PDF this\n" +
        "app produces, and a downloaded file does not reliably carry it. Read\n" +
        "it off hts.usitc.gov and pass it exactly.\n\n" +
        USAGE,
    );
  }
  const revision = args.revision.trim();

  const files = collectInputFiles(args);
  console.log("HTSUS import");
  console.log(`  revision: ${revision}`);
  console.log(`  files:    ${files.length}`);
  console.log(`  target:   ${DATA_DIR}`);
  console.log("");

  const allLines: HtsLine[] = [];
  const rawPayloads: string[] = [];
  let idOffset = 0;

  for (const file of files) {
    const rows = readRows(file);
    if (rows.length === 0) continue;

    const { lines, warnings: parseWarnings } = parseUsitcRows(rows);
    for (const parseWarning of parseWarnings) {
      warn(`${path.basename(file)}: ${parseWarning}`);
    }

    for (const line of lines) {
      line.id += idOffset;
      if (line.parentId !== null) line.parentId += idOffset;
    }
    idOffset += lines.length;

    allLines.push(...lines);
    rawPayloads.push(fs.readFileSync(file, "utf8"));

    const reportable = lines.filter((line) => line.isReportable).length;
    console.log(
      `  ${path.basename(file)}: ${lines.length} lines (${reportable} reportable)`,
    );
  }

  if (allLines.length === 0) {
    throw new Error(
      "No tariff lines were read — refusing to write an empty index.\n\n" + USAGE,
    );
  }

  let scheduleB: ScheduleBEntry[] = [];
  if (args.scheduleB) {
    const resolved = path.resolve(args.scheduleB);
    if (fs.existsSync(resolved)) {
      scheduleB = parseConcordance(fs.readFileSync(resolved, "utf8"));
      if (scheduleB.length === 0) {
        warn(`${path.basename(resolved)}: parsed to zero Schedule B entries.`);
      }
    } else {
      warn(`Schedule B file not found: ${resolved}`);
    }
  }

  // The browser export carries tariff lines only. Notes live in the PDF
  // edition, and GRI 1 makes them binding, so this is a real limitation of the
  // import path and it belongs in the manifest where the UI will surface it.
  warn(
    "Imported from a file export, which does not include Section or Chapter " +
      "Notes or the General Rules of Interpretation. The agent is told they " +
      "could not be consulted rather than that none exist. Run `npm run " +
      "sync:htsus` from a network with access to hts.usitc.gov for the complete set.",
  );

  const chapters = new Set(allLines.map((line) => line.chapter).filter(Boolean));
  const reportableLineCount = allLines.filter((line) => line.isReportable).length;

  const manifest: HtsusManifest = {
    revision,
    publishedDate: null,
    retrievedAt: new Date().toISOString(),
    sourceUrl: `file import (${files.length} file${files.length === 1 ? "" : "s"})`,
    sha256: crypto.createHash("sha256").update(rawPayloads.join("\n")).digest("hex"),
    chapterCount: chapters.size,
    lineCount: allLines.length,
    reportableLineCount,
    noteCount: 0,
    scheduleBCount: scheduleB.length,
    warnings,
  };

  const revisionDir = path.join(DATA_DIR, slugify(revision));
  fs.mkdirSync(revisionDir, { recursive: true });

  console.log("\nBuilding index...");
  buildIndex(path.join(revisionDir, INDEX_FILENAME), {
    lines: allLines,
    notes: [],
    scheduleB,
    manifest,
  });
  fs.writeFileSync(
    path.join(revisionDir, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log("");
  console.log(`Done. ${revision}`);
  console.log(`  chapters:   ${chapters.size}`);
  console.log(`  lines:      ${allLines.length} (${reportableLineCount} reportable)`);
  console.log(`  schedule B: ${scheduleB.length}`);
  console.log(`  warnings:   ${warnings.length}`);
  console.log(`  written to: ${revisionDir}`);
}

const invokedDirectly = /import-htsus(\.[cm]?tsx?|\.[cm]?js)?$/.test(
  process.argv[1] ?? "",
);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
