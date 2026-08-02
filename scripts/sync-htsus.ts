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

// This runs as a standalone script rather than inside Next, so nothing has
// loaded .env.local for us. Without this, an overridden HTSUS_DATA_DIR or
// CENSUS_CONCORDANCE_URL would be silently ignored here while the app honoured
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
 * Empty by default, deliberately.
 *
 * Census does not publish a direct HTS-to-Schedule B crosswalk at a stable
 * URL. What it does publish under /reference/codes/concordance/ is
 * `expconcordNN.xlsx` — a Schedule B commodity list concorded to SITC,
 * end-use and NAICS — and a matching import concordance for HTS. Neither maps
 * one schedule onto the other.
 *
 * The two numbers coincide for many simple goods and diverge for others, so
 * deriving one from the other by string equality would produce confident,
 * wrong export codes. For a tool whose whole point is verified classification
 * that is the wrong trade, so Schedule B stays off until a real source is
 * chosen. Set this to a delimited file with HTS and Schedule B columns to
 * switch it on.
 */
const CENSUS_CONCORDANCE_URL = process.env.CENSUS_CONCORDANCE_URL ?? "";

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
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--probe") {
      args.probe = true;
    } else if (flag === "--revision") {
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
  if (!CENSUS_CONCORDANCE_URL) {
    warn(
      "Schedule B export codes are unavailable: no HTS-to-Schedule B crosswalk " +
        "is configured. Census publishes the two schedules' concordances " +
        "separately (each mapping to SITC/NAICS), not to each other, and " +
        "inferring one from the other by code equality would produce confident " +
        "but sometimes wrong export codes. Set CENSUS_CONCORDANCE_URL to a " +
        "delimited file with HTS and Schedule B columns to enable this.",
    );
    return [];
  }

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
      label: "Schedule B concordance",
      url: CENSUS_CONCORDANCE_URL,
      expect: "delimited text with two 10-digit code columns per row",
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

      if (target.label.startsWith("Schedule B")) {
        log(`  parsed:   ${parseConcordance(body).length} entries`);
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
