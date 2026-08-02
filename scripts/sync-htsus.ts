/**
 * Download the active HTSUS revision from USITC and build the local index.
 *
 *   npm run sync:htsus
 *   npm run sync:htsus -- --revision "2026 HTS Revision 13"
 *   npm run sync:htsus -- --chapters 84,85,96      # partial pull, for dev
 *   npm run sync:htsus -- --probe                  # diagnose sources, write nothing
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
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { extractText, getDocumentProxy } from "unpdf";
import { parseUsitcRows } from "../src/lib/hts/parse";
import { parseScheduleB } from "../src/lib/hts/scheduleB";
import {
  INDEX_FILENAME,
  MANIFEST_FILENAME,
  buildIndex,
} from "../src/lib/hts/store";
import type {
  HtsLine,
  HtsNote,
  HtsusManifest,
  ScheduleBLine,
  UsitcRawRow,
} from "../src/lib/hts/types";

// This runs as a standalone script rather than inside Next, so nothing has
// loaded .env.local for us. Without this, an overridden HTSUS_DATA_DIR or
// CENSUS_SCHEDULE_B_BASE would be silently ignored here while the app honoured
// it — the sync would write where the app is not looking.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local is fine; every value below has a working default.
}

/**
 * Route fetch through HTTPS_PROXY when one is configured.
 *
 * Node's global fetch ignores HTTPS_PROXY by default. In a proxied network it
 * therefore bypasses the tunnel and fails with an opaque 403 that reads like
 * the remote host rejecting you — while curl, in the same shell, succeeds.
 * That combination is genuinely hard to diagnose, so it is worth handling.
 *
 * NODE_USE_ENV_PROXY cannot be set from here: Node reads it during bootstrap,
 * long before this line runs. Installing an explicit dispatcher is the
 * portable fix, and it needs no shell-specific env var syntax.
 */
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const BASE_URL = (
  process.env.USITC_BASE_URL ?? "https://hts.usitc.gov/reststop"
).replace(/\/+$/, "");
const DATA_DIR = path.resolve(process.env.HTSUS_DATA_DIR ?? "./data/htsus");
/**
 * Where Census publishes the Schedule B editions. Each year lives at
 * `<base>/<year>/exp-code.txt`, a fixed-width file of every export code, with
 * its record layout alongside at `exp-stru.txt`.
 */
const CENSUS_SCHEDULE_B_BASE = (
  process.env.CENSUS_SCHEDULE_B_BASE ??
  "https://www.census.gov/foreign-trade/schedules/b"
).replace(/\/+$/, "");

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
  probe?: boolean;
  scheduleBYear?: string;
  skipScheduleB?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--probe") {
      args.probe = true;
    } else if (flag === "--revision") {
      args.revision = argv[++i];
    } else if (flag === "--schedule-b-year") {
      args.scheduleBYear = (argv[++i] ?? "").trim();
    } else if (flag === "--no-schedule-b") {
      args.skipScheduleB = true;
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

  // /currentRelease is the one that exists and answers with clean JSON:
  //   {"name":"2026HTSRev14","description":"2026 HTS Revision 14", ...}
  // /releases 404s, but is kept as a fallback in case USITC reinstates it.
  for (const endpoint of ["/currentRelease", "/releases"]) {
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
      // Chapter 77 is reserved for future use in the Harmonized System and is
      // genuinely empty, so it is not worth alarming anyone about. An empty
      // chapter 84 would be a real problem.
      if (cc === "77") {
        log(`  ch ${cc}: empty (reserved for future use in the HS)`);
      } else {
        warn(`Chapter ${cc}: returned zero rows.`);
      }
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
    const bytes = Buffer.from(await response.arrayBuffer());

    // Sniff the payload rather than trusting the header: USITC serves these as
    // application/octet-stream regardless of what they actually are, so a
    // content-type check would pass PDFs straight through and we would decode
    // binary as text and store the garbage as tariff notes.
    if (isPdf(bytes)) {
      const doc = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(doc, { mergePages: true });
      const notes = notesSectionOf(text);
      return notes.length > 40 ? notes : null;
    }

    const cleaned = stripMarkup(bytes.toString("utf8"));
    return cleaned.length > 40 ? cleaned : null;
  } catch {
    return null;
  }
}

export function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * Trim an extracted chapter PDF to just its notes.
 *
 * Each chapter PDF is the notes followed by the full tariff table. We already
 * hold the table as structured rows, so keeping it here would duplicate tens
 * of thousands of characters and push the actual notes out of the tool's
 * output window. The table reliably opens with its column headers, which makes
 * a clean cut point.
 */
export function notesSectionOf(text: string): string {
  const markers = ["Rates of Duty", "Article Description", "Heading/"];
  const cut = markers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index > 200)
    .sort((a, b) => a - b)[0];

  const notes = cut === undefined ? text : text.slice(0, cut);
  return notes.replace(/\s+/g, " ").trim();
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
// Step 4 — Schedule B (the export schedule)
// ---------------------------------------------------------------------------

/** Where Census publishes an edition's fixed-width commodity file. */
export function scheduleBUrl(year: string): string {
  return `${CENSUS_SCHEDULE_B_BASE}/${year}/exp-code.txt`;
}

/**
 * Candidate edition years, newest first.
 *
 * Census publishes the next edition late in the preceding year, so "the
 * current year" is not reliably the newest available, and early in a year the
 * newest may still be last year's. Probing a short window and taking the first
 * that answers is both correct and cheap — and unlike the HTSUS revision, the
 * edition year is discoverable from the URL itself, so there is nothing to
 * guess once a file is found.
 */
export function scheduleBEditionCandidates(now = new Date()): string[] {
  const year = now.getUTCFullYear();
  return [year + 1, year, year - 1].map(String);
}

interface ScheduleBFetch {
  lines: ScheduleBLine[];
  edition: string | null;
}

async function fetchScheduleB(
  explicitYear?: string,
): Promise<ScheduleBFetch> {
  const years = explicitYear ? [explicitYear] : scheduleBEditionCandidates();

  for (const year of years) {
    const url = scheduleBUrl(year);
    try {
      const response = await fetchWithRetry(url, 1);
      const { lines, warnings: parseWarnings } = parseScheduleB(
        await response.text(),
      );
      if (lines.length === 0) {
        // A 200 that parses to nothing means the layout moved, not that the
        // edition is missing; say so rather than silently trying last year.
        warn(`Schedule B ${year} downloaded but parsed to zero records (${url}).`);
        continue;
      }
      for (const message of parseWarnings) warn(message);
      log(`  Schedule B ${year}: ${lines.length} export codes`);
      return { lines, edition: year };
    } catch {
      // A missing edition year is expected while probing; keep looking.
    }
  }

  warn(
    `Schedule B could not be retrieved from ${CENSUS_SCHEDULE_B_BASE} ` +
      `(tried editions ${years.join(", ")}). Export codes will be unavailable ` +
      `for this snapshot; the app will say so rather than guess them.`,
  );
  return { lines: [], edition: null };
}

/**
 * How well the export schedule covers the tariff, measured rather than assumed.
 *
 * The two schedules share the 6-digit HS subheading by construction, but
 * "by construction" is a claim about intent. This checks it against the two
 * files actually downloaded, so a drift between editions shows up as a warning
 * on the snapshot instead of as a missing export code months later.
 */
export function scheduleBCoverage(
  htsLines: readonly HtsLine[],
  scheduleB: readonly ScheduleBLine[],
): { reportable: number; covered: number; orphanHs6: string[] } {
  const hs6 = new Set(scheduleB.map((entry) => entry.hs6));
  const reportable = htsLines.filter((line) => line.isReportable);
  const covered = reportable.filter((line) => hs6.has(line.digits.slice(0, 6)));
  const orphanHs6 = [
    ...new Set(
      reportable
        .filter((line) => !hs6.has(line.digits.slice(0, 6)))
        .map((line) => line.digits.slice(0, 6)),
    ),
  ].sort();
  return { reportable: reportable.length, covered: covered.length, orphanHs6 };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Hit every source once and report exactly what came back, without writing
 * anything.
 *
 * This exists because the three things most likely to be wrong — the release
 * listing endpoint, the notes filename convention, and the Census concordance
 * URL — cannot be diagnosed from a normal sync run's output. A failed sync
 * says "could not retrieve"; this says what the server actually sent, which is
 * what you need in order to fix it.
 */
async function probeSources(): Promise<void> {
  log("Probing sources. Nothing will be written.\n");

  const targets: { label: string; url: string; expect: string }[] = [
    {
      label: "Release listing",
      url: `${BASE_URL}/releases`,
      expect: 'JSON or HTML naming the current "<year> HTS Revision <n>"',
    },
    {
      label: "Current release",
      url: `${BASE_URL}/currentRelease`,
      expect: "same, alternate endpoint",
    },
    {
      label: "Tariff lines (ch 84)",
      url: `${BASE_URL}/exportList?from=8400&to=8499&format=JSON&styles=false`,
      expect: "JSON array of rows with htsno / indent / description",
    },
    {
      label: "Chapter notes (ch 84)",
      url: `${BASE_URL}/file?release=currentRelease&filename=${encodeURIComponent("Chapter 84")}`,
      expect: "text or HTML; a PDF content-type means notes cannot be parsed",
    },
    {
      label: "General Notes (GRIs)",
      url: `${BASE_URL}/file?release=currentRelease&filename=${encodeURIComponent("General Notes")}`,
      expect: "text or HTML containing the rules of interpretation",
    },
    {
      label: "Schedule B record layout",
      url: `${CENSUS_SCHEDULE_B_BASE}/${scheduleBEditionCandidates()[1]}/exp-stru.txt`,
      expect: "the published field positions; diff against LAYOUT in scheduleB.ts",
    },
    {
      label: "Schedule B codes",
      url: scheduleBUrl(scheduleBEditionCandidates()[1]),
      expect: "fixed-width records, 278 chars each, starting with a 10-digit code",
    },

    // The three below are unverified leads rather than endpoints this script
    // uses. They are probed because they would each answer an open question,
    // and probing costs one request.
    {
      label: "File endpoint control (Change Record)",
      url: `${BASE_URL}/file?release=currentRelease&filename=${encodeURIComponent("Change Record")}`,
      expect:
        "any 200. This isolates cause: if this works but 'Chapter 84' does not, the file endpoint is fine and our filename convention is wrong",
    },
    {
      label: "Section detail JSON (lead)",
      url: `${BASE_URL}/api/details/sectionJSON?query=&offset=0&limit=5`,
      expect:
        "unverified. If it returns section/chapter note text, it would close the notes gap in the file-import path",
    },
    {
      label: "HTS number detail JSON (lead)",
      url: `${BASE_URL}/api/details/htsnoJSON/8507.60.00.20`,
      expect: "unverified. A per-code detail lookup, possibly richer than exportList",
    },
  ];

  for (const target of targets) {
    log(`--- ${target.label} ---`);
    log(`  url:      ${target.url}`);
    log(`  expected: ${target.expect}`);

    try {
      const response = await fetchWithRetry(target.url, 1);
      const body = await response.text();
      const contentType = response.headers.get("content-type") ?? "unknown";

      log(`  status:   ${response.status} ${response.statusText}`);
      log(`  type:     ${contentType}`);
      log(`  bytes:    ${body.length}`);

      const found = extractRevision(body);
      if (found) log(`  revision: ${found.revision} (${found.publishedDate ?? "no date"})`);

      if (target.label.startsWith("Tariff lines")) {
        try {
          const parsed: unknown = JSON.parse(body);
          if (Array.isArray(parsed)) {
            log(`  rows:     ${parsed.length}`);
            log(`  keys:     ${Object.keys((parsed[0] ?? {}) as object).join(", ") || "(none)"}`);
          } else {
            log(`  rows:     NOT AN ARRAY (got ${typeof parsed})`);
          }
        } catch {
          log("  rows:     body is not valid JSON");
        }
      }

      if (target.label === "Schedule B codes") {
        const { lines, warnings: parseWarnings } = parseScheduleB(body);
        log(`  parsed:   ${lines.length} export codes`);
        log(`  hs6:      ${new Set(lines.map((l) => l.hs6)).size} distinct subheadings`);
        for (const message of parseWarnings.slice(0, 3)) log(`  warn:     ${message}`);
      }

      log(`  head:     ${JSON.stringify(body.slice(0, 300))}`);
    } catch (error) {
      log(
        `  FAILED:   ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    log("");
  }

  log(
    "Send this output back if anything above looks wrong — it contains every\n" +
      "detail needed to correct the fetchers.",
  );
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

  if (args.probe) {
    await probeSources();
    return;
  }

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

  log("\nFetching Schedule B...");
  const { lines: scheduleB, edition: scheduleBEdition } = args.skipScheduleB
    ? { lines: [] as ScheduleBLine[], edition: null }
    : await fetchScheduleB(args.scheduleBYear);

  if (scheduleB.length > 0) {
    const coverage = scheduleBCoverage(lines, scheduleB);
    const pct = ((coverage.covered / coverage.reportable) * 100).toFixed(1);
    log(
      `  coverage: ${coverage.covered}/${coverage.reportable} reportable HTS lines ` +
        `(${pct}%) reach at least one export code at HS-6`,
    );
    // The schedules are meant to share HS-6, so a large gap means the editions
    // have drifted apart and analysts should know before they rely on it.
    if (coverage.covered / coverage.reportable < 0.95) {
      warn(
        `Only ${pct}% of reportable HTS lines map to a Schedule B subheading ` +
          `(expected ~99%). The HTSUS revision and Schedule B ${scheduleBEdition} ` +
          `edition may be out of step. Uncovered subheadings: ` +
          `${coverage.orphanHs6.slice(0, 10).join(", ")}${coverage.orphanHs6.length > 10 ? ", …" : ""}.`,
      );
    }
  }

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
    scheduleBEdition,
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
  log(
    `  schedule B: ${scheduleB.length}` +
      (scheduleBEdition ? ` (${scheduleBEdition} edition)` : " (unavailable)"),
  );
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
// Checked via argv rather than import.meta so the module loads under both
// CommonJS and ESM — vitest imports it, the CLI executes it.
const invokedDirectly = /sync-htsus(\.[cm]?tsx?|\.[cm]?js)?$/.test(
  process.argv[1] ?? "",
);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
