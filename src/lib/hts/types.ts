/**
 * Types for the HTSUS data layer.
 *
 * The USITC `exportList` endpoint returns a *flat* list of rows whose
 * hierarchy is encoded only in an `indent` column. Reconstructing the tree is
 * the single most important thing this layer does, because a classification is
 * only legible when you can read the full path:
 *
 *   8507 → Electric storage batteries …
 *     8507.60 → Lithium-ion batteries
 *       8507.60.00 → (rate line: Free)
 *         8507.60.00.20 → Of a kind used as the primary source of electrical
 *                          power for electrically powered vehicles
 */

/** A row exactly as USITC returns it, before any normalisation. */
export interface UsitcRawRow {
  htsno?: string | null;
  indent?: string | number | null;
  description?: string | null;
  superior?: string | null;
  units?: string[] | null;
  general?: string | null;
  special?: string | null;
  other?: string | null;
  footnotes?: unknown;
  quotaQuantity?: string | null;
  additionalDuties?: string | null;
  /**
   * USITC ships this misspelled key alongside the correct one. Both appear in
   * live `exportList` output, and which one carries the value is not
   * consistent, so the parser reads whichever is populated.
   */
  addiitionalDuties?: string | null;
}

/**
 * Digit count of an HTS number, which is also its taxonomic level.
 * 4 = heading, 6 = international subheading, 8 = US subheading (rate line),
 * 10 = statistical reporting number (the thing you actually declare).
 */
export type HtsLevel = 0 | 2 | 4 | 6 | 8 | 10;

export interface HtsLine {
  /** Stable row id within a revision snapshot. */
  id: number;
  /** Formatted number as published, e.g. "8507.60.00.20". Empty for header-only rows. */
  htsNo: string;
  /** Digits only, e.g. "8507600020". Empty for header-only rows. */
  digits: string;
  level: HtsLevel;
  indent: number;
  chapter: string;
  heading: string;
  description: string;
  /** Ancestor descriptions, outermost first, including this row's own. */
  descriptionPath: string[];
  units: string[];
  /** Duty rates, resolved by inheritance — see `resolveRates`. */
  general: string;
  special: string;
  other: string;
  /**
   * The HTS number the rates were actually read from. When a 10-digit
   * statistical line carries no rates of its own it inherits them from its
   * 8-digit parent, and a determination needs to say so rather than imply the
   * stat line published those rates itself.
   */
  ratesInheritedFrom: string | null;
  footnotes: string[];
  quotaQuantity: string | null;
  additionalDuties: string | null;
  parentId: number | null;
  /** True only for 10-digit lines — the ones that can be declared on an entry. */
  isReportable: boolean;
}

export interface HtsNote {
  /** "general" (GRI, Additional US Rules), "section", or "chapter". */
  kind: "general" | "section" | "chapter";
  /** e.g. "GRI", "XVI", "85". */
  ref: string;
  title: string;
  body: string;
}

export interface ScheduleBEntry {
  hts10: string;
  scheduleB: string;
  description: string;
}

export interface Chapter99Entry {
  /** The Chapter 99 subheading, e.g. "9903.88.03". */
  htsNo: string;
  description: string;
  /** Additional ad valorem duty text as published, e.g. "The duty provided…25%". */
  additionalDuty: string;
  /** Programme label inferred from the subheading range, e.g. "Section 301 (China)". */
  program: string;
}

/**
 * Provenance for a synced snapshot. This is the authoritative source of the
 * HTSUS version stamp that appears on every exported determination — nothing
 * in the app hardcodes a revision.
 */
export interface HtsusManifest {
  /** e.g. "2026 HTS Revision 13". */
  revision: string;
  /** ISO date the revision was published by USITC, when discoverable. */
  publishedDate: string | null;
  /** ISO timestamp this snapshot was pulled. */
  retrievedAt: string;
  sourceUrl: string;
  /** SHA-256 over the concatenated raw chapter payloads. */
  sha256: string;
  chapterCount: number;
  lineCount: number;
  reportableLineCount: number;
  noteCount: number;
  scheduleBCount: number;
  /** Non-fatal problems hit during sync — surfaced in the UI, not swallowed. */
  warnings: string[];
}

export interface HtsSearchHit {
  htsNo: string;
  description: string;
  descriptionPath: string[];
  level: HtsLevel;
  general: string;
  special: string;
  other: string;
  units: string[];
  isReportable: boolean;
  /** FTS relevance; lower is better (bm25). */
  score: number;
}
