/**
 * Schedule B — the export-side commodity schedule.
 *
 * Census publishes the whole schedule as one fixed-width text file
 * (`exp-code.txt`), whose layout it also publishes (`exp-stru.txt`). That
 * makes this the export analogue of the USITC feed: an authoritative, complete,
 * machine-readable list rather than a derived crosswalk.
 *
 * ## Why we store the schedule and not a mapping
 *
 * The obvious shortcut — assume the Schedule B number equals the HTS number —
 * is wrong far more often than it is right. Measured against 2026 HTS Revision
 * 14, only about 30% of reportable HTSUS 10-digit numbers have an identical
 * 10-digit Schedule B code. The two schedules share the 6-digit international
 * HS subheading and then break out differently below it, because they are
 * counting different things: imports are broken out by what affects duty,
 * exports by what the Census Bureau wants to measure. Vacuum flasks are the
 * clean example — HTSUS splits 9617.00 by capacity (over/under one litre),
 * Schedule B splits it by whether the article is complete or a part.
 *
 * So the honest join is at HS-6, which is common to both by construction, and
 * that is what {@link scheduleBHs6} produces. It yields *candidates*, not an
 * answer: 45% of HTS numbers land on exactly one Schedule B code, and the rest
 * need someone to read the descriptions and choose. That choice is a
 * classification decision in its own right — GRI 1 through 6 applied to the
 * export schedule — and it belongs to the analyst and the model, not to a
 * string comparison.
 */

import type { ScheduleBLine } from "./types";

/**
 * Field positions from `exp-stru.txt`, as published, 1-indexed and inclusive.
 * Kept in the published form so it can be diffed against Census's spec without
 * mental arithmetic; {@link field} does the conversion.
 */
const LAYOUT = {
  code: [1, 10],
  shortDescription: [15, 65],
  description: [70, 219],
  unit1: [225, 227],
  unit2: [233, 235],
  sitc: [241, 245],
  endUse: [251, 255],
  usda: [261, 261],
  naics: [266, 271],
  hiTech: [277, 278],
} as const satisfies Record<string, readonly [number, number]>;

function field(line: string, [from, to]: readonly [number, number]): string {
  return line.slice(from - 1, to).trim();
}

/** Re-apply canonical dotting: "9617002000" -> "9617.00.20.00". */
export function formatScheduleB(code: string): string {
  const d = code.replace(/\D/g, "");
  if (d.length !== 10) return code;
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}.${d.slice(8, 10)}`;
}

/** The 6-digit HS subheading a code sits under — the only safe join key. */
export function scheduleBHs6(code: string): string {
  return code.replace(/\D/g, "").slice(0, 6);
}

export interface ParseScheduleBResult {
  lines: ScheduleBLine[];
  warnings: string[];
}

/**
 * Parse `exp-code.txt`.
 *
 * Every record in the live file is exactly 278 characters and begins with a
 * 10-digit code, but the parser does not depend on that: a short line is
 * padded rather than throwing, since a truncated trailing field is survivable
 * while losing the whole schedule is not. A line whose code is not 10 digits is
 * skipped and counted — that is the one shape change that would mean the
 * layout has moved under us, and it needs to surface rather than be absorbed.
 */
export function parseScheduleB(text: string): ParseScheduleBResult {
  const warnings: string[] = [];
  const lines: ScheduleBLine[] = [];
  const seen = new Set<string>();

  const rows = text.split(/\r?\n/);
  let skipped = 0;

  for (const raw of rows) {
    if (raw.trim() === "") continue;
    const row = raw.length < 278 ? raw.padEnd(278, " ") : raw;

    const code = field(row, LAYOUT.code);
    if (!/^\d{10}$/.test(code)) {
      skipped += 1;
      if (skipped <= 3) {
        warnings.push(
          `Schedule B line does not begin with a 10-digit code and was skipped: "${raw.slice(0, 40)}".`,
        );
      }
      continue;
    }
    if (seen.has(code)) continue;
    seen.add(code);

    const description = field(row, LAYOUT.description);
    const shortDescription = field(row, LAYOUT.shortDescription);

    lines.push({
      code,
      htsNo: formatScheduleB(code),
      hs6: code.slice(0, 6),
      chapter: code.slice(0, 2),
      // The long field is empty on a few records; the short one always carries
      // something, and an abbreviated description beats none.
      description: description || shortDescription,
      shortDescription: shortDescription || description,
      units: [field(row, LAYOUT.unit1), field(row, LAYOUT.unit2)].filter(Boolean),
      sitc: field(row, LAYOUT.sitc) || null,
      endUse: field(row, LAYOUT.endUse) || null,
      naics: field(row, LAYOUT.naics) || null,
      // "1" flags an agricultural commodity; anything else is non-agricultural.
      isAgricultural: field(row, LAYOUT.usda) === "1",
      hiTech: field(row, LAYOUT.hiTech) || null,
    });
  }

  if (skipped > 3) {
    warnings.push(
      `${skipped} Schedule B lines in total were skipped for not beginning with a 10-digit code. ` +
        `If this is a large fraction of the file, the Census record layout has changed — check exp-stru.txt.`,
    );
  }

  return { lines, warnings };
}
