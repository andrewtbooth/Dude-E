/**
 * Turns the USITC flat row list into a navigable tree.
 *
 * Two things make this non-trivial, and both matter for correctness of a
 * determination rather than being cosmetic:
 *
 * 1. **Hierarchy is implicit.** Rows carry only an `indent` depth. A row's
 *    meaning is its own text *prefixed by every ancestor's text* — read alone,
 *    "Other" is worthless; read as its full path it is precise.
 *
 * 2. **Rates are inherited.** A 10-digit statistical line usually publishes no
 *    duty rate of its own; the rate lives on its 8-digit parent. We resolve
 *    that inheritance but record where the rate came from, so the PDF can be
 *    honest about which line actually published it.
 *
 * The parser is deliberately tolerant of shape drift (USITC has changed its
 * response format without notice before) but never silently invents data: a
 * row it cannot make sense of is dropped and counted as a warning.
 */

import type { HtsLevel, HtsLine, UsitcRawRow } from "./types";

export interface ParseResult {
  lines: HtsLine[];
  warnings: string[];
}

/** Strip formatting to bare digits. "8507.60.00.20" -> "8507600020". */
export function toDigits(htsNo: string): string {
  return htsNo.replace(/\D/g, "");
}

/**
 * Re-apply canonical HTSUS dotting to a bare digit string.
 * 4 -> 8507, 6 -> 8507.60, 8 -> 8507.60.00, 10 -> 8507.60.00.20
 */
export function formatHtsNo(digits: string): string {
  const d = toDigits(digits);
  if (d.length <= 4) return d;
  const parts = [d.slice(0, 4)];
  if (d.length > 4) parts.push(d.slice(4, 6));
  if (d.length > 6) parts.push(d.slice(6, 8));
  if (d.length > 8) parts.push(d.slice(8, 10));
  return parts.join(".");
}

export function levelOf(digits: string): HtsLevel {
  const n = digits.length;
  if (n === 2 || n === 4 || n === 6 || n === 8 || n === 10) return n as HtsLevel;
  return 0;
}

function coerceIndent(raw: UsitcRawRow["indent"]): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function coerceStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) =>
        typeof entry === "string" ? entry : entry == null ? "" : String(entry),
      )
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim() !== "") return [raw.trim()];
  return [];
}

function clean(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Build the tree. Rows arrive in document order, which is what makes an
 * indent stack sufficient: a row's parent is always the most recent row at
 * `indent - 1`.
 */
export function parseUsitcRows(
  rows: readonly UsitcRawRow[],
  options: { chapter?: string } = {},
): ParseResult {
  const warnings: string[] = [];
  const lines: HtsLine[] = [];

  // Open ancestors, in strictly increasing indent order. A stack indexed *by*
  // indent cannot represent the real feed: USITC sometimes jumps indent by more
  // than one (2826.90.90 goes 2 -> 4), which leaves holes that later rows read
  // as missing ancestors. Keeping the stack dense and popping by comparison
  // handles jumps, and equal-indent siblings, without either case being special.
  const stack: { id: number; indent: number }[] = [];
  const byId = new Map<number, HtsLine>();

  rows.forEach((row, index) => {
    const indent = coerceIndent(row.indent);
    const description = clean(row.description);
    const htsNoRaw = clean(row.htsno);

    if (indent === null) {
      // A row with no usable depth cannot be placed in the hierarchy. Placing
      // it by guesswork would corrupt every descendant's description path.
      if (htsNoRaw || description) {
        warnings.push(
          `Row ${index} (${htsNoRaw || "no hts number"}) has an unreadable indent and was skipped.`,
        );
      }
      return;
    }

    if (!htsNoRaw && !description) return; // genuinely blank spacer row

    const digits = toDigits(htsNoRaw);
    if (htsNoRaw && digits.length === 0) {
      warnings.push(
        `Row ${index} has an HTS number with no digits ("${htsNoRaw}") and was skipped.`,
      );
      return;
    }

    // Anything at or below this row's depth is closed; the nearest shallower
    // row is the parent. Attaching an indent-jumped row to root instead — as a
    // by-index stack does — is not a cosmetic loss: its description path
    // collapses to its own text, and rate resolution finds no ancestor, so a
    // 10-digit line publishes a blank duty rate where the schedule plainly
    // gives it one.
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1] ?? null;
    const parentId = top?.id ?? null;
    const parent = parentId === null ? null : (byId.get(parentId) ?? null);

    if (top && indent > top.indent + 1) {
      // An indent jump is only worth reporting when the recovery is doubtful.
      //
      // USITC numbers indents inconsistently, so jumps are routine and the
      // stack lands the row on the right ancestor nearly every time: a 10-digit
      // statistical line whose parent is its own dotted prefix is parented
      // correctly, whatever the indent column claimed. Reporting those anyway
      // produced 27 warnings on a snapshot where all 27 were correct — which
      // trains an operator to ignore the count, and buries the one warning that
      // would matter. Warn only when the ancestor is *not* the row's prefix,
      // because that is a genuine misattachment: the description path and the
      // inherited duty rate would both come from the wrong branch.
      const ancestorHtsNo = lines[top.id]?.htsNo ?? "";
      const parentedByPrefix =
        ancestorHtsNo !== "" && htsNoRaw.startsWith(ancestorHtsNo);

      if (!parentedByPrefix) {
        warnings.push(
          `Row ${index} (${htsNoRaw || "no hts number"}) jumps from indent ` +
            `${top.indent} to ${indent} and was attached to ` +
            `${ancestorHtsNo || "an unnumbered row"}, which is not its prefix. ` +
            `Its description path and inherited rates may come from the wrong ` +
            `branch — check this line before relying on it.`,
        );
      }
    }

    const id = lines.length;
    const level = levelOf(digits);
    const chapter =
      digits.slice(0, 2) || parent?.chapter || options.chapter || "";
    const heading = digits.slice(0, 4) || parent?.heading || "";

    const line: HtsLine = {
      id,
      htsNo: htsNoRaw,
      digits,
      level,
      indent,
      chapter,
      heading,
      description,
      descriptionPath: parent
        ? [...parent.descriptionPath, description]
        : [description],
      units: coerceStringArray(row.units),
      general: clean(row.general),
      special: clean(row.special),
      other: clean(row.other),
      ratesInheritedFrom: null,
      footnotes: coerceFootnotes(row.footnotes),
      quotaQuantity: clean(row.quotaQuantity) || null,
      // USITC publishes both spellings; take whichever is populated.
      additionalDuties:
        clean(row.additionalDuties) || clean(row.addiitionalDuties) || null,
      parentId,
      // Provisional. Whether a line can be declared depends on whether
      // anything sits beneath it, which is not known until every row has been
      // read — see resolveReportable below.
      isReportable: false,
    };

    lines.push(line);
    byId.set(id, line);

    // This row is now the innermost open ancestor.
    stack.push({ id, indent });
  });

  resolveRates(lines, byId);
  resolveReportable(lines);
  return { lines, warnings };
}

/**
 * Mark the lines that can actually appear on an entry.
 *
 * The rule is "nothing is published beneath it", not "it has ten digits".
 *
 * Ten digits is right for almost the whole schedule, and was the rule here
 * until it turned out to be wrong in exactly the places that matter most.
 * 3,564 subheadings in the 2026 Rev 15 snapshot terminate at eight digits:
 *
 *   3,095 in Chapter 99 — Section 301 and 232 provisions
 *     374 in Chapter 98 — 9801 American goods returned, 9802 outward
 *                         processing, 9804 personal exemptions, and most of
 *                         the 9813 temporary-importation-under-bond series
 *      95 in Chapter 91 — watch provisions with no statistical breakout
 *
 * These are not lines whose ten-digit children were lost in parsing. USITC
 * publishes an explicit `.00` reporting number wherever an eight-digit
 * subheading has no breakout — 8,080 of the 19,949 ten-digit lines end that
 * way — so a subheading with no child is terminal as published.
 *
 * Chapter 99 is excluded regardless. Its provisions are additional duties
 * declared *alongside* a Chapter 1-97 classification, never instead of one, and
 * they are checked on their own path (see verifyChapter99). Letting them
 * through here would allow a run to answer "9903.88.03" to "what is this
 * product", which is not a classification at all.
 */
function resolveReportable(lines: HtsLine[]): void {
  const hasChildren = new Set<number>();
  for (const line of lines) {
    if (line.parentId !== null) hasChildren.add(line.parentId);
  }

  for (const line of lines) {
    line.isReportable =
      line.digits.length >= 8 &&
      line.chapter !== "99" &&
      !hasChildren.has(line.id);
  }
}

function coerceFootnotes(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && "value" in entry) {
          return String((entry as { value: unknown }).value ?? "");
        }
        return "";
      })
      .map((entry) => entry.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  return [];
}

/**
 * Walk each line up its ancestry until a published `general` rate is found.
 * Special and Column 2 ("other") ride along from the same ancestor so the
 * three rates are always read off one consistent line rather than stitched
 * together from different levels.
 */
function resolveRates(lines: HtsLine[], byId: Map<number, HtsLine>): void {
  for (const line of lines) {
    if (line.general) continue;

    let cursor = line.parentId === null ? null : byId.get(line.parentId);
    while (cursor) {
      if (cursor.general) {
        line.general = cursor.general;
        line.special = line.special || cursor.special;
        line.other = line.other || cursor.other;
        line.ratesInheritedFrom = cursor.htsNo || null;
        break;
      }
      cursor = cursor.parentId === null ? null : byId.get(cursor.parentId);
    }
  }
}

/** Flattened text used for full-text search. Path first so ancestors rank. */
export function searchText(line: HtsLine): string {
  return line.descriptionPath.filter(Boolean).join(" > ");
}
