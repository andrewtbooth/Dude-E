/**
 * SQLite-backed HTSUS index: builder + reader.
 *
 * Why a local index rather than proxying USITC per request:
 *   - their `/reststop/search` caps at 100 results with weak ranking;
 *   - a GRI analysis needs Section/Chapter *notes* and full indent trees,
 *     which search does not return at all;
 *   - the version stamp on a determination has to be a fact read from data,
 *     and that means pinning a snapshot rather than querying a moving target.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config";
import { formatHtsNo, searchText, toDigits } from "./parse";
import type {
  Chapter99Entry,
  HtsLevel,
  HtsLine,
  HtsNote,
  HtsSearchHit,
  HtsusManifest,
  ScheduleBLine,
  ScheduleBMatch,
} from "./types";

export const INDEX_FILENAME = "htsus.db";
export const MANIFEST_FILENAME = "manifest.json";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS lines (
  id                  INTEGER PRIMARY KEY,
  hts_no              TEXT NOT NULL,
  digits              TEXT NOT NULL,
  level               INTEGER NOT NULL,
  indent              INTEGER NOT NULL,
  chapter             TEXT NOT NULL,
  heading             TEXT NOT NULL,
  description         TEXT NOT NULL,
  description_path    TEXT NOT NULL,
  units               TEXT NOT NULL,
  general             TEXT NOT NULL,
  special             TEXT NOT NULL,
  other               TEXT NOT NULL,
  rates_inherited_from TEXT,
  footnotes           TEXT NOT NULL,
  quota_quantity      TEXT,
  additional_duties   TEXT,
  parent_id           INTEGER,
  is_reportable       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lines_digits   ON lines(digits);
CREATE INDEX IF NOT EXISTS idx_lines_chapter  ON lines(chapter);
CREATE INDEX IF NOT EXISTS idx_lines_heading  ON lines(heading);
CREATE INDEX IF NOT EXISTS idx_lines_parent   ON lines(parent_id);

CREATE VIRTUAL TABLE IF NOT EXISTS lines_fts USING fts5(
  path_text,
  description,
  hts_no UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS notes (
  id    INTEGER PRIMARY KEY,
  kind  TEXT NOT NULL,
  ref   TEXT NOT NULL,
  title TEXT NOT NULL,
  body  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_ref ON notes(kind, ref);

-- The export schedule in full, keyed on its own code. The link to HTSUS is
-- derived at query time from the shared 6-digit HS subheading rather than
-- stored, because no authoritative 10-digit crosswalk exists — see
-- scheduleB.ts.
CREATE TABLE IF NOT EXISTS schedule_b (
  code              TEXT PRIMARY KEY,
  hts_no            TEXT NOT NULL,
  hs6               TEXT NOT NULL,
  chapter           TEXT NOT NULL,
  description       TEXT NOT NULL,
  short_description TEXT NOT NULL,
  units             TEXT NOT NULL,
  sitc              TEXT,
  end_use           TEXT,
  naics             TEXT,
  is_agricultural   INTEGER NOT NULL,
  hi_tech           TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduleb_hs6 ON schedule_b(hs6);

CREATE VIRTUAL TABLE IF NOT EXISTS schedule_b_fts USING fts5(
  description,
  code UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Builder (used by scripts/sync-htsus.ts)
// ---------------------------------------------------------------------------

export interface BuildIndexInput {
  lines: HtsLine[];
  notes: HtsNote[];
  scheduleB: ScheduleBLine[];
  manifest: HtsusManifest;
}

export function buildIndex(dbPath: string, input: BuildIndexInput): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);

  const db = new Database(dbPath);
  try {
    db.exec(SCHEMA);

    const insertLine = db.prepare(`
      INSERT INTO lines (
        id, hts_no, digits, level, indent, chapter, heading, description,
        description_path, units, general, special, other, rates_inherited_from,
        footnotes, quota_quantity, additional_duties, parent_id, is_reportable
      ) VALUES (
        @id, @hts_no, @digits, @level, @indent, @chapter, @heading, @description,
        @description_path, @units, @general, @special, @other, @rates_inherited_from,
        @footnotes, @quota_quantity, @additional_duties, @parent_id, @is_reportable
      )
    `);
    const insertFts = db.prepare(
      `INSERT INTO lines_fts (rowid, path_text, description, hts_no) VALUES (?, ?, ?, ?)`,
    );
    const insertNote = db.prepare(
      `INSERT INTO notes (kind, ref, title, body) VALUES (?, ?, ?, ?)`,
    );
    const insertScheduleB = db.prepare(`
      INSERT INTO schedule_b (
        code, hts_no, hs6, chapter, description, short_description, units,
        sitc, end_use, naics, is_agricultural, hi_tech
      ) VALUES (
        @code, @hts_no, @hs6, @chapter, @description, @short_description, @units,
        @sitc, @end_use, @naics, @is_agricultural, @hi_tech
      )
    `);
    const insertScheduleBFts = db.prepare(
      `INSERT INTO schedule_b_fts (rowid, description, code) VALUES (?, ?, ?)`,
    );
    const insertMeta = db.prepare(
      `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
    );

    db.transaction(() => {
      for (const line of input.lines) {
        insertLine.run({
          id: line.id,
          hts_no: line.htsNo,
          digits: line.digits,
          level: line.level,
          indent: line.indent,
          chapter: line.chapter,
          heading: line.heading,
          description: line.description,
          description_path: JSON.stringify(line.descriptionPath),
          units: JSON.stringify(line.units),
          general: line.general,
          special: line.special,
          other: line.other,
          rates_inherited_from: line.ratesInheritedFrom,
          footnotes: JSON.stringify(line.footnotes),
          quota_quantity: line.quotaQuantity,
          additional_duties: line.additionalDuties,
          parent_id: line.parentId,
          is_reportable: line.isReportable ? 1 : 0,
        });
        insertFts.run(line.id, searchText(line), line.description, line.htsNo);
      }
      for (const note of input.notes) {
        insertNote.run(note.kind, note.ref, note.title, note.body);
      }
      input.scheduleB.forEach((entry, index) => {
        insertScheduleB.run({
          code: entry.code,
          hts_no: entry.htsNo,
          hs6: entry.hs6,
          chapter: entry.chapter,
          description: entry.description,
          short_description: entry.shortDescription,
          units: JSON.stringify(entry.units),
          sitc: entry.sitc,
          end_use: entry.endUse,
          naics: entry.naics,
          is_agricultural: entry.isAgricultural ? 1 : 0,
          hi_tech: entry.hiTech,
        });
        // FTS rowids are positional; nothing joins on them, so the index is fine.
        insertScheduleBFts.run(index + 1, entry.description, entry.code);
      });
      insertMeta.run("manifest", JSON.stringify(input.manifest));
    })();

    db.exec("INSERT INTO lines_fts(lines_fts) VALUES('optimize')");
    db.exec("INSERT INTO schedule_b_fts(schedule_b_fts) VALUES('optimize')");
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export class HtsusIndexMissingError extends Error {
  constructor(dir: string) {
    super(
      `No HTSUS index found under ${dir}. Run \`npm run sync:htsus\` to download ` +
        `the current revision from USITC and build the index.`,
    );
    this.name = "HtsusIndexMissingError";
  }
}

interface OpenIndex {
  db: Database.Database;
  manifest: HtsusManifest;
  revisionDir: string;
  /** Identity of the manifest this handle was opened against. */
  fingerprint: string | null;
}

let cached: OpenIndex | null = null;

/**
 * Resolve the most recently retrieved snapshot. Snapshots are directories
 * under HTSUS_DATA_DIR; we pick by manifest `retrievedAt` rather than by
 * directory name so a re-pull of the same revision wins.
 */
function resolveLatestRevisionDir(root: string): string {
  if (!fs.existsSync(root)) throw new HtsusIndexMissingError(root);

  const candidates = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter(
      (dir) =>
        fs.existsSync(path.join(dir, INDEX_FILENAME)) &&
        fs.existsSync(path.join(dir, MANIFEST_FILENAME)),
    );

  if (candidates.length === 0) throw new HtsusIndexMissingError(root);

  return candidates.sort((a, b) => {
    const at = readManifestFile(a)?.retrievedAt ?? "";
    const bt = readManifestFile(b)?.retrievedAt ?? "";
    return bt.localeCompare(at);
  })[0];
}

function readManifestFile(dir: string): HtsusManifest | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, MANIFEST_FILENAME), "utf8"),
    ) as Partial<HtsusManifest>;

    // Snapshots outlive the code that wrote them, so fields added later are
    // absent from manifests already on disk. Normalising here keeps the
    // declared type honest instead of leaving `undefined` behind a `boolean`.
    // Both defaults are the conservative reading of an older snapshot: no
    // partial-pull tag means it was a full sync, and no recorded Schedule B
    // edition means no export codes were stamped.
    return {
      ...parsed,
      isPartial: parsed.isPartial === true,
      scheduleBEdition: parsed.scheduleBEdition ?? null,
    } as HtsusManifest;
  } catch {
    return null;
  }
}

/**
 * How often to re-check whether the snapshot on disk has moved under us.
 *
 * A long-running server used to hold its handle for the life of the process,
 * so after `npm run sync:htsus` it kept serving the previous index *and* kept
 * stamping determinations with the previous revision — silently, because on
 * Linux the deleted file stays readable behind the open descriptor. The
 * version stamp is the thing this whole system rests on, so it cannot be
 * allowed to drift from what is actually installed.
 *
 * Checking a manifest's mtime is cheap; doing it on every query would still be
 * wasteful, so it is throttled.
 */
const SNAPSHOT_RECHECK_MS = 30_000;

let lastCheckedAt = 0;

function manifestFingerprint(revisionDir: string): string | null {
  try {
    const stat = fs.statSync(path.join(revisionDir, MANIFEST_FILENAME));
    return `${revisionDir}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function open(): OpenIndex {
  const now = Date.now();

  if (cached) {
    if (now - lastCheckedAt < SNAPSHOT_RECHECK_MS) return cached;
    lastCheckedAt = now;

    const currentDir = resolveLatestRevisionDir(config.htsusDataDir);
    const fingerprint = manifestFingerprint(currentDir);
    // A missing or unreadable manifest means a sync is mid-flight. Keep serving
    // the snapshot we already have rather than tearing down a working index to
    // race a directory that is still being written.
    if (fingerprint !== null && fingerprint !== cached.fingerprint) {
      cached.db.close();
      cached = null;
    } else {
      return cached;
    }
  }

  lastCheckedAt = now;
  const revisionDir = resolveLatestRevisionDir(config.htsusDataDir);
  const manifest = readManifestFile(revisionDir);
  if (!manifest) throw new HtsusIndexMissingError(config.htsusDataDir);

  const db = new Database(path.join(revisionDir, INDEX_FILENAME), {
    readonly: true,
    fileMustExist: true,
  });

  cached = {
    db,
    manifest,
    revisionDir,
    fingerprint: manifestFingerprint(revisionDir),
  };
  return cached;
}

/** Drop the cached handle. Called by tests; a live sync is picked up on its own. */
export function resetStore(): void {
  cached?.db.close();
  cached = null;
  lastCheckedAt = 0;
}

/**
 * The authoritative HTSUS version stamp. Everything that writes provenance
 * — determinations, PDFs, the masthead — reads it from here.
 */
export function getActiveRevision(): HtsusManifest {
  return open().manifest;
}

/** Non-throwing variant for surfaces that must render before a sync has run. */
export function tryGetActiveRevision(): HtsusManifest | null {
  try {
    return getActiveRevision();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface LineRow {
  id: number;
  hts_no: string;
  digits: string;
  level: number;
  indent: number;
  chapter: string;
  heading: string;
  description: string;
  description_path: string;
  units: string;
  general: string;
  special: string;
  other: string;
  rates_inherited_from: string | null;
  footnotes: string;
  quota_quantity: string | null;
  additional_duties: string | null;
  parent_id: number | null;
  is_reportable: number;
}

function mapLine(row: LineRow): HtsLine {
  return {
    id: row.id,
    htsNo: row.hts_no,
    digits: row.digits,
    level: row.level as HtsLevel,
    indent: row.indent,
    chapter: row.chapter,
    heading: row.heading,
    description: row.description,
    descriptionPath: JSON.parse(row.description_path) as string[],
    units: JSON.parse(row.units) as string[],
    general: row.general,
    special: row.special,
    other: row.other,
    ratesInheritedFrom: row.rates_inherited_from,
    footnotes: JSON.parse(row.footnotes) as string[],
    quotaQuantity: row.quota_quantity,
    additionalDuties: row.additional_duties,
    parentId: row.parent_id,
    isReportable: row.is_reportable === 1,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * FTS5 treats bare punctuation as query syntax, and the agent writes natural
 * language. Quote every token so a query like "lithium-ion (18650) cells"
 * cannot become a syntax error.
 */
function toFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 1);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token}"`).join(" OR ");
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to 10-digit statistical lines. */
  reportableOnly?: boolean;
  /** Two-digit chapter, e.g. "85". */
  chapter?: string;
}

export function searchHts(
  query: string,
  options: SearchOptions = {},
): HtsSearchHit[] {
  const { db } = open();
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const filters: string[] = [];
  const params: Record<string, string | number> = { q: ftsQuery, limit };

  if (options.reportableOnly) filters.push("l.is_reportable = 1");
  if (options.chapter) {
    filters.push("l.chapter = @chapter");
    params.chapter = options.chapter.padStart(2, "0");
  }
  const where = filters.length ? `AND ${filters.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT l.*, bm25(lines_fts, 1.0, 2.0) AS score
         FROM lines_fts
         JOIN lines l ON l.id = lines_fts.rowid
        WHERE lines_fts MATCH @q ${where}
        ORDER BY score
        LIMIT @limit`,
    )
    .all(params) as (LineRow & { score: number })[];

  return rows.map((row) => {
    const line = mapLine(row);
    return {
      htsNo: line.htsNo,
      description: line.description,
      descriptionPath: line.descriptionPath,
      level: line.level,
      general: line.general,
      special: line.special,
      other: line.other,
      units: line.units,
      isReportable: line.isReportable,
      score: row.score,
    };
  });
}

/**
 * Exact lookup by HTS number, tolerant of formatting. Returns null when the
 * number does not exist in this revision — which is exactly what the
 * anti-fabrication check in the API layer relies on.
 */
export function lookupExact(htsNo: string): HtsLine | null {
  const { db } = open();
  const digits = toDigits(htsNo);
  if (!digits) return null;

  const row = db
    .prepare(`SELECT * FROM lines WHERE digits = ? ORDER BY id LIMIT 1`)
    .get(digits) as LineRow | undefined;
  return row ? mapLine(row) : null;
}

/**
 * Everything at or beneath an HTS number, in document order. This is what the
 * agent reads to compare sibling statistical breakouts under GRI 6.
 */
export function getSubtree(htsNo: string, maxRows = 400): HtsLine[] {
  const { db } = open();
  const digits = toDigits(htsNo);
  if (!digits) return [];

  const rows = db
    .prepare(
      `SELECT * FROM lines
        WHERE digits LIKE ? || '%' AND digits != ''
        ORDER BY id
        LIMIT ?`,
    )
    .all(digits, maxRows) as LineRow[];

  const lines = rows.map(mapLine);
  if (lines.length === 0) return lines;

  // Re-read the id span to reinstate the unnumbered header rows that sit
  // between numbered siblings; without them the slice reads as a list of bare
  // "Other" entries with nothing to distinguish them.
  //
  // The span is bounded by the capped query above, so it can only *add* header
  // rows — which is exactly why it must not reuse `maxRows`. Doing so let the
  // headers consume the cap and pushed real matches off the end silently: for
  // heading 6204 that hid 77 lines, everything past 6204.63.75, with no
  // truncation marker. A caller comparing siblings under GRI 6 would conclude
  // those breakouts do not exist.
  const minId = lines[0].id;
  const maxId = lines[lines.length - 1].id;
  const withHeaders = db
    .prepare(`SELECT * FROM lines WHERE id BETWEEN ? AND ? ORDER BY id`)
    .all(minId, maxId) as LineRow[];
  return withHeaders.map(mapLine);
}

/** Ancestor chain for a line, outermost first. */
export function getAncestors(htsNo: string): HtsLine[] {
  const { db } = open();
  const start = lookupExact(htsNo);
  if (!start) return [];

  const chain: HtsLine[] = [];
  let parentId = start.parentId;
  const stmt = db.prepare(`SELECT * FROM lines WHERE id = ?`);
  while (parentId !== null) {
    const row = stmt.get(parentId) as LineRow | undefined;
    if (!row) break;
    const line = mapLine(row);
    chain.unshift(line);
    parentId = line.parentId;
  }
  return chain;
}

export function getNotes(
  kind: HtsNote["kind"],
  ref?: string,
): HtsNote[] {
  const { db } = open();
  const rows = ref
    ? (db
        .prepare(`SELECT kind, ref, title, body FROM notes WHERE kind = ? AND ref = ?`)
        .all(kind, ref) as HtsNote[])
    : (db
        .prepare(`SELECT kind, ref, title, body FROM notes WHERE kind = ? ORDER BY ref`)
        .all(kind) as HtsNote[]);
  return rows;
}

/** Verbatim GRI + Additional U.S. Rules of Interpretation text. */
export function getGeneralRules(): HtsNote[] {
  return getNotes("general");
}

interface ScheduleBRow {
  code: string;
  hts_no: string;
  hs6: string;
  chapter: string;
  description: string;
  short_description: string;
  units: string;
  sitc: string | null;
  end_use: string | null;
  naics: string | null;
  is_agricultural: number;
  hi_tech: string | null;
}

function hydrateScheduleB(row: ScheduleBRow): ScheduleBLine {
  return {
    code: row.code,
    htsNo: row.hts_no,
    hs6: row.hs6,
    chapter: row.chapter,
    description: row.description,
    shortDescription: row.short_description,
    units: JSON.parse(row.units) as string[],
    sitc: row.sitc,
    endUse: row.end_use,
    naics: row.naics,
    isAgricultural: row.is_agricultural === 1,
    hiTech: row.hi_tech,
  };
}

/**
 * Schedule B candidates for an HTSUS number, joined at the shared HS-6
 * subheading.
 *
 * Deliberately returns every candidate under the subheading rather than
 * guessing between them. The two schedules break out differently below HS-6,
 * so narrowing further is a classification judgement about the goods — read
 * the descriptions and decide — not something a query can do.
 */
export function getScheduleB(htsNo: string): ScheduleBMatch {
  const { db } = open();
  const digits = toDigits(htsNo);
  const hs6 = digits.slice(0, 6);
  if (hs6.length < 6) {
    return { hs6, candidates: [], hasIdenticalCode: false };
  }

  const rows = db
    .prepare(`SELECT * FROM schedule_b WHERE hs6 = ? ORDER BY code`)
    .all(hs6) as ScheduleBRow[];

  return {
    hs6,
    candidates: rows.map(hydrateScheduleB),
    hasIdenticalCode:
      digits.length === 10 && rows.some((row) => row.code === digits),
  };
}

/** Look up one Schedule B code exactly — the export-side anti-fabrication check. */
export function lookupScheduleB(code: string): ScheduleBLine | null {
  const { db } = open();
  const digits = toDigits(code);
  if (digits.length !== 10) return null;
  const row = db
    .prepare(`SELECT * FROM schedule_b WHERE code = ?`)
    .get(digits) as ScheduleBRow | undefined;
  return row ? hydrateScheduleB(row) : null;
}

/**
 * Full-text search over the export schedule.
 *
 * Needed because the HS-6 join has a floor: about 0.6% of HTSUS numbers sit
 * under a subheading Schedule B does not use, and for those the only route to
 * an export code is to search the schedule on its own terms.
 */
export function searchScheduleB(query: string, limit = 20): ScheduleBLine[] {
  const { db } = open();
  const match = toFtsQuery(query);
  if (!match) return [];
  const rows = db
    .prepare(
      `SELECT b.* FROM schedule_b_fts f
         JOIN schedule_b b ON b.code = f.code
        WHERE schedule_b_fts MATCH ?
        ORDER BY bm25(schedule_b_fts)
        LIMIT ?`,
    )
    .all(match, limit) as ScheduleBRow[];
  return rows.map(hydrateScheduleB);
}

/**
 * Chapter 99 additional duties applicable to a base HTS number.
 *
 * The linkage in the published tariff is a footnote on the base line ("See
 * 9903.88.03."), so we read the footnotes of the line *and its ancestors* —
 * the reference is usually published on the 8-digit rate line, not the
 * 10-digit statistical breakout the analyst is actually classifying to.
 */
export function getChapter99Candidates(htsNo: string): Chapter99Entry[] {
  const line = lookupExact(htsNo);
  if (!line) return [];

  const footnotes = [
    ...getAncestors(htsNo).flatMap((ancestor) => ancestor.footnotes),
    ...line.footnotes,
  ];

  const refs = new Set<string>();
  for (const note of footnotes) {
    for (const match of note.matchAll(/\b(99\d{2}(?:\.\d{2}){1,2})/g)) {
      refs.add(match[1]);
    }
  }

  const entries: Chapter99Entry[] = [];
  for (const ref of refs) {
    const target = lookupExact(ref);
    if (!target) continue;
    entries.push({
      htsNo: target.htsNo || formatHtsNo(ref),
      description: target.descriptionPath.filter(Boolean).join(" > "),
      additionalDuty: target.general || target.additionalDuties || "",
      program: classifyChapter99Program(toDigits(ref)),
    });
  }
  return entries;
}

/**
 * Label a Chapter 99 subheading by the trade action that created it. Ranges
 * are stable enough to name, but this is a convenience label — the
 * authoritative text is the subheading's own description.
 */
function classifyChapter99Program(digits: string): string {
  const subchapter = digits.slice(0, 6);
  if (subchapter.startsWith("990388")) return "Section 301 (China)";
  if (subchapter.startsWith("990391")) return "Section 301 (China), exclusions";
  if (subchapter.startsWith("990380")) return "Section 232 (steel)";
  if (subchapter.startsWith("990385")) return "Section 232 (aluminum)";
  if (subchapter.startsWith("990394")) return "Section 232 / IEEPA action";
  if (digits.startsWith("9903")) return "Chapter 99, Subchapter III (temporary duties)";
  if (digits.startsWith("9902")) return "Chapter 99, Subchapter II (temporary reductions)";
  return "Chapter 99 additional duty";
}

export interface IndexStats {
  lineCount: number;
  reportableLineCount: number;
  noteCount: number;
  scheduleBCount: number;
  /** Distinct HS-6 subheadings the export schedule covers. */
  scheduleBHs6Count: number;
}

export function getIndexStats(): IndexStats {
  const { db } = open();
  const one = (sql: string) =>
    (db.prepare(sql).get() as { n: number }).n;
  return {
    lineCount: one("SELECT COUNT(*) AS n FROM lines"),
    reportableLineCount: one(
      "SELECT COUNT(*) AS n FROM lines WHERE is_reportable = 1",
    ),
    noteCount: one("SELECT COUNT(*) AS n FROM notes"),
    scheduleBCount: one("SELECT COUNT(*) AS n FROM schedule_b"),
    scheduleBHs6Count: one("SELECT COUNT(DISTINCT hs6) AS n FROM schedule_b"),
  };
}
