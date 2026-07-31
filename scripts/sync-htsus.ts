/**
 * Download the active HTSUS revision from USITC and build the local index.
 *
 *   npm run sync:htsus
 *   npm run sync:htsus -- --revision "2026 HTS Revision 13"
 *   npm run sync:htsus -- --chapters 84,85,96      # partial pull, for dev
 *
 * Design notes
 * ------------
 * Each source is fetched in its own step and failures are collected as
 * warnings rather than aborting the run, because a snapshot missing (say) the
 * Schedule B concordance is still far more useful than no snapshot at all.
 * The one thing that *does* abort is an unresolvable revision label: a
 * determination stamped with the wrong HTSUS version is worse than one that
 * was never produced, so we refuse to guess.
 *
 * USITC has changed this API's response shape without notice before. Every
 * parser here is written to tolerate drift and to report loudly when it finds
 * something it does not understand.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseUsitcRows } from "../src/lib/hts/parse";
import {
  INDEX_FILENAME,
  MANIFEST_FILENAME,
  buildIndex,
} from "../src/lib/hts/store";
import type {
  HtsLine,
  HtsNote,
  HtsusManifest,
  ScheduleBEntry,
  UsitcRawRow,
} from "../src/lib/hts/types";

const BASE_URL = (
  process.env.USITC_BASE_URL ?? "https://hts.usitc.gov/reststop"
).replace(/\/+$/, "");
const DATA_DIR = path.resolve(process.env.HTSUS_DATA_DIR ?? "./data/htsus");
const CENSUS_CONCORDANCE_URL =
  process.env.CENSUS_CONCORDANCE_URL ??
  "https://www.census.gov/foreign-trade/aes/documentlibrary/concordance/hts-sb-concordance.txt";

const USER_AGENT =
  "Dude-E-TariffClassifier/0.1 (internal compliance tool; +https://github.com/andrewtbooth/Dude-E)";

const warnings: string[] = [];

function warn(message: string): void {
  warnings.push(message);
  console.warn(`  ! ${message}`);
}

function log(message: string): void {
  console.log(message);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  revision?: string;
  chapters?: number[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--revision") {
      args.revision = argv[++i];
    } else if (flag === "--chapters") {
      args.chapters = (argv[++i] ?? "")
        .split(",")
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 99);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  url: string,
  attempts = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      // 4xx other than 429 will not fix themselves.
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      const backoff = 2 ** attempt * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw new Error(
    `Failed to fetch ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

// ---------------------------------------------------------------------------
// Step 1 — resolve the revision label (fatal on failure)
// ---------------------------------------------------------------------------

interface RevisionInfo {
  revision: string;
  publishedDate: string | null;
}

/**
 * The revision label is the provenance anchor for every artifact this app
 * produces, so it is the one value we will not infer. We try the API, then
 * fall back to an explicit `--revision` flag, then give up with instructions.
 */
async function resolveRevision(override?: string): Promise<RevisionInfo> {
  if (override) {
    log(`Revision: ${override} (supplied via --revision)`);
    return { revision: override, publishedDate: null };
  }

  for (const endpoint of ["/releases", "/currentRelease"]) {
    try {
      const response = await fetchWithRetry(`${BASE_URL}${endpoint}`, 1);
      const text = await response.text();
      const info = extractRevision(text);
      if (info) {
        log(`Revision: ${info.revision} (discovered via ${endpoint})`);
        return info;
      }
    } catch {
      // Try the next discovery path.
    }
  }

  throw new Error(
    [
      "Could not determine the active HTSUS revision from USITC.",
      "",
      "The revision label is stamped onto every determination and PDF, so this",
      "script will not guess it. Check the current revision at",
      "https://hts.usitc.gov and re-run with it supplied explicitly:",
      "",
      '  npm run sync:htsus -- --revision "2026 HTS Revision 13"',
    ].join("\n"),
  );
}

/** Pull a "<year> HTS Revision <n>" label out of JSON or HTML. */
export function extractRevision(payload: string): RevisionInfo | null {
  const label = payload.match(/(20\d{2})\s*HTS\s*Revision\s*(\d+)/i);
  if (!label) return null;

  const revision = `${label[1]} HTS Revision ${label[2]}`;

  // Look for an accompanying date in either ISO or US format.
  const iso = payload.match(/(20\d{2}-\d{2}-\d{2})/);
  if (iso) return { revision, publishedDate: iso[1] };

  const us = payload.match(/\b(\d{2})\/(\d{2})\/(20\d{2})\b/);
  if (us) return { revision, publishedDate: `${us[3]}-${us[1]}-${us[2]}` };

  return { revision, publishedDate: null };
}

// ---------------------------------------------------------------------------
// Step 2 — tariff lines, chapter by chapter
// ---------------------------------------------------------------------------

async function fetchChapters(
  chapters: number[],
): Promise<{ lines: HtsLine[]; rawPayloads: string[]; fetched: number }> {
  const allLines: HtsLine[] = [];
  const rawPayloads: string[] = [];
  let fetched = 0;
  let idOffset = 0;

  for (const chapter of chapters) {
    const cc = String(chapter).padStart(2, "0");
    const url = `${BASE_URL}/exportList?from=${cc}00&to=${cc}99&format=JSON&styles=false`;

    let body: string;
    try {
      const response = await fetchWithRetry(url);
      body = await response.text();
    } catch (error) {
      warn(
        `Chapter ${cc}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    let rows: UsitcRawRow[];
    try {
      const parsed: unknown = JSON.parse(body);
      if (!Array.isArray(parsed)) {
        warn(
          `Chapter ${cc}: expected a JSON array, got ${typeof parsed}. ` +
            `The USITC response shape may have changed — first 200 chars: ` +
            `${body.slice(0, 200)}`,
        );
        continue;
      }
      rows = parsed as UsitcRawRow[];
    } catch {
      warn(
        `Chapter ${cc}: response was not valid JSON. First 200 chars: ${body.slice(0, 200)}`,
      );
      continue;
    }

    if (rows.length === 0) {
      // Chapters 77, 98 and 99 legitimately vary; an empty 84 would not.
      warn(`Chapter ${cc}: returned zero rows.`);
      continue;
    }

    const { lines, warnings: parseWarnings } = parseUsitcRows(rows, {
      chapter: cc,
    });
    for (const parseWarning of parseWarnings) {
      warn(`Chapter ${cc}: ${parseWarning}`);
    }

    // Re-key ids and parent pointers into the global sequence.
    for (const line of lines) {
      line.id += idOffset;
      if (line.parentId !== null) line.parentId += idOffset;
    }
    idOffset += lines.length;

    allLines.push(...lines);
    rawPayloads.push(body);
    fetched += 1;

    const reportable = lines.filter((l) => l.isReportable).length;
    log(`  ch ${cc}: ${lines.length} lines (${reportable} reportable)`);
  }

  return { lines: allLines, rawPayloads, fetched };
}

// ---------------------------------------------------------------------------
// Step 3 — General Rules and Section/Chapter notes
// ---------------------------------------------------------------------------

/**
 * Notes are what make a GRI 1 analysis legitimate — the heading terms are read
 * *together with* the relative Section and Chapter notes. If a chapter's notes
 * cannot be retrieved we record it explicitly, because the agent must be able
 * to tell "this chapter has no notes" apart from "we failed to fetch them".
 */
async function fetchNotes(chapters: number[]): Promise<HtsNote[]> {
  const notes: HtsNote[] = [];

  const general = await fetchNoteDocument("General Notes");
  if (general) {
    notes.push({
      kind: "general",
      ref: "GRI",
      title: "General Notes, General Rules of Interpretation, and Additional U.S. Rules of Interpretation",
      body: general,
    });
  } else {
    warn(
      "General Notes (including the GRIs) could not be retrieved. The agent " +
        "will fall back to its built-in copy of the GRI text — verify before relying on output.",
    );
  }

  for (const chapter of chapters) {
    const cc = String(chapter).padStart(2, "0");
    const body = await fetchNoteDocument(`Chapter ${chapter}`);
    if (body) {
      notes.push({
        kind: "chapter",
        ref: cc,
        title: `Chapter ${chapter} Notes`,
        body,
      });
    } else {
      warn(`Chapter ${cc}: notes could not be retrieved.`);
    }
  }

  return notes;
}

async function fetchNoteDocument(filename: string): Promise<string | null> {
  const url = `${BASE_URL}/file?release=currentRelease&filename=${encodeURIComponent(filename)}`;
  try {
    const response = await fetchWithRetry(url, 2);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("pdf")) {
      // The notes endpoint sometimes serves PDF. We do not ship a PDF text
      // extractor for a build-time script; record it rather than pretend.
      return null;
    }
    const text = await response.text();
    const cleaned = stripMarkup(text);
    return cleaned.length > 40 ? cleaned : null;
  } catch {
    return null;
  }
}

export function stripMarkup(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Step 4 — Schedule B concordance
// ---------------------------------------------------------------------------

/**
 * Census publishes an HTS-to-Schedule B concordance as a delimited text file.
 * The column layout has changed across years, so we detect the two code
 * columns by shape (10 digits each) rather than by fixed position.
 */
export function parseConcordance(text: string): ScheduleBEntry[] {
  const entries: ScheduleBEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const fields = line.includes("\t")
      ? line.split("\t")
      : line.includes("|")
        ? line.split("|")
        : line.split(",");

    const codes: string[] = [];
    let description = "";
    for (const field of fields) {
      const value = field.trim().replace(/^"|"$/g, "");
      const digits = value.replace(/\D/g, "");
      if (digits.length === 10 && /^[\d.\s-]+$/.test(value)) {
        codes.push(digits);
      } else if (value.length > description.length && /[a-z]/i.test(value)) {
        description = value;
      }
    }

    if (codes.length >= 2) {
      const key = `${codes[0]}:${codes[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        hts10: codes[0],
        scheduleB: `${codes[1].slice(0, 4)}.${codes[1].slice(4, 6)}.${codes[1].slice(6)}`,
        description,
      });
    }
  }

  return entries;
}

async function fetchScheduleB(): Promise<ScheduleBEntry[]> {
  try {
    const response = await fetchWithRetry(CENSUS_CONCORDANCE_URL, 2);
    const entries = parseConcordance(await response.text());
    if (entries.length === 0) {
      warn(
        `Schedule B concordance at ${CENSUS_CONCORDANCE_URL} parsed to zero entries. ` +
          `Export codes will be unavailable; set CENSUS_CONCORDANCE_URL to the current file.`,
      );
    }
    return entries;
  } catch (error) {
    warn(
      `Schedule B concordance unavailable (${error instanceof Error ? error.message : String(error)}). ` +
        `Export codes will not be offered.`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function slugify(revision: string): string {
  return revision
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const chapters =
    args.chapters && args.chapters.length > 0
      ? args.chapters
      : Array.from({ length: 99 }, (_, i) => i + 1);

  log(`HTSUS sync`);
  log(`  source:   ${BASE_URL}`);
  log(`  target:   ${DATA_DIR}`);
  log(`  chapters: ${chapters.length}`);
  log("");

  const { revision, publishedDate } = await resolveRevision(args.revision);

  log("\nFetching tariff lines...");
  const { lines, rawPayloads, fetched } = await fetchChapters(chapters);

  if (lines.length === 0) {
    throw new Error(
      "No tariff lines were retrieved — refusing to write an empty index. " +
        "Check network access to hts.usitc.gov and re-run.",
    );
  }

  log("\nFetching notes...");
  const notes = await fetchNotes(chapters);

  log("\nFetching Schedule B concordance...");
  const scheduleB = await fetchScheduleB();

  const sha256 = crypto
    .createHash("sha256")
    .update(rawPayloads.join("\n"))
    .digest("hex");

  const reportableLineCount = lines.filter((l) => l.isReportable).length;

  const manifest: HtsusManifest = {
    revision,
    publishedDate,
    retrievedAt: new Date().toISOString(),
    sourceUrl: BASE_URL,
    sha256,
    chapterCount: fetched,
    lineCount: lines.length,
    reportableLineCount,
    noteCount: notes.length,
    scheduleBCount: scheduleB.length,
    warnings,
  };

  const revisionDir = path.join(DATA_DIR, slugify(revision));
  fs.mkdirSync(revisionDir, { recursive: true });

  log("\nBuilding index...");
  buildIndex(path.join(revisionDir, INDEX_FILENAME), {
    lines,
    notes,
    scheduleB,
    manifest,
  });
  fs.writeFileSync(
    path.join(revisionDir, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  log("");
  log(`Done. ${revision}`);
  log(`  chapters:   ${fetched}/${chapters.length}`);
  log(`  lines:      ${lines.length} (${reportableLineCount} reportable)`);
  log(`  notes:      ${notes.length}`);
  log(`  schedule B: ${scheduleB.length}`);
  log(`  warnings:   ${warnings.length}`);
  log(`  written to: ${revisionDir}`);

  if (warnings.length > 0) {
    log(
      `\nThe snapshot was written with ${warnings.length} warning(s). They are recorded in ` +
        `${MANIFEST_FILENAME} and surfaced in the app so analysts can see what is incomplete.`,
    );
  }
}

// Only run when invoked directly, so the parsers above stay unit-testable.
const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
