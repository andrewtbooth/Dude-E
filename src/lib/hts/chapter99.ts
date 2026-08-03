/**
 * Chapter 99 coverage, recovered from the subchapter U.S. Notes.
 *
 * ## The problem this solves
 *
 * Section 301 and 232 exposure is the single largest duty consequence in the
 * tariff, and until now the app was almost blind to it. The only linkage it
 * used was a `See 9903.xx.xx.` footnote published on a base line, which exists
 * for a minority of covered goods — 771 of 35,789 lines in 2026 Revision 14.
 * Staple 301-exposed goods carry no such footnote at all: metal furniture
 * (9403.20.00), cotton T-shirts (6109.10.00) and lithium-ion batteries
 * (8507.60.00) all came back "no Chapter 99 provisions found".
 *
 * The actual coverage is defined the other way round. A Chapter 99 heading
 * says, in its subchapter U.S. Note, which base subheadings it reaches:
 *
 *   (k) The rates of duty in heading 9903.85.08 apply to all entries of
 *       derivative aluminum products classifiable in the following HTSUS
 *       provisions … 0402.99.68; 0402.99.70; 0402.99.90; 2106…
 *
 * Those notes live in the Chapter 99 document — 2.6 MB of text — after the
 * first tariff table, which is why the notes extraction never saw them.
 *
 * ## What this deliberately does not do
 *
 * It produces a **screening flag, not a duty determination.** The notes carry
 * conditions this parser does not evaluate: country of origin, effective and
 * expiry dates, granted exclusions, and carve-outs that turn coverage off for
 * particular goods. Resolving those correctly requires reading the note.
 *
 * So an entry here means "this subheading is enumerated in a Chapter 99 note —
 * read it", which is exactly the prompt a compliance analyst needs and is
 * honest about its own limits. Asserting a rate from it would be the confident,
 * wrong answer this whole application exists to avoid.
 */

import { tableHeaderIndex } from "./notes";

/** A Chapter 99 note that enumerates the subheadings it reaches. */
export interface Chapter99Coverage {
  /** Base 8-digit subheading, bare digits, e.g. "94032000". */
  baseDigits: string;
  /** Note reference as published, e.g. "19(k)". Empty when undeterminable. */
  noteRef: string;
  /** Chapter 99 headings named in the note's operative sentence. */
  headings: string[];
  /** The operative sentence, so a reader can judge without opening the PDF. */
  excerpt: string;
}

/** Subdivision heading: "(k)" or "19. (k)" at the start of a line. */
const SUBDIVISION = /\n[ \t]*(?:(\d{1,2})\.[ \t]*)?\(([a-z]{1,3})\)[ \t]/g;
/** An 8-digit HTS number in published form. */
const HTS8 = /(?<!\d)(\d{4})\.(\d{2})\.(\d{2})(?!\d)/g;
/** A Chapter 99 heading. */
const CH99 = /9903\.\d{2}\.\d{2}|991[0-9]\.\d{2}\.\d{2}|990[124]\.\d{2}\.\d{2}/g;

/**
 * How many enumerated subheadings make a block a *list* rather than prose.
 *
 * Notes routinely mention a handful of subheadings while discussing scope. A
 * genuine coverage list runs to dozens. Five is comfortably above conversational
 * use and well below the smallest real list observed (22).
 */
const MIN_ENUMERATED = 5;

/** Characters of the opening sentence kept as evidence. */
const EXCERPT_CHARS = 320;

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Parse the Chapter 99 document's notes into per-subheading coverage rows.
 *
 * Takes the *full* extracted text, not the trimmed notes section — the
 * subchapter notes sit after the first tariff table.
 */
export function parseChapter99Coverage(text: string): Chapter99Coverage[] {
  const marks: { at: number; note: string | undefined; letter: string }[] = [];
  for (const match of text.matchAll(SUBDIVISION)) {
    marks.push({ at: match.index, note: match[1], letter: match[2] });
  }

  const rows: Chapter99Coverage[] = [];
  // One row per (subheading, note) pair; a subheading can appear in several.
  const seen = new Set<string>();

  marks.forEach((mark, index) => {
    const end = marks[index + 1]?.at ?? text.length;
    // Bound the block at the tariff table. The last subdivision before a table
    // otherwise runs straight into it and treats every code printed in the
    // table's rows as an enumerated subheading — 667 spurious codes from one
    // block in the live document, which would have flagged goods no Chapter 99
    // note mentions.
    const raw = text.slice(mark.at, end);
    // Zero minimum: a subdivision can be short and still be followed straight
    // away by the table, and the document-level guard would miss that.
    const tableAt = tableHeaderIndex(raw, 0);
    const block = tableAt === null ? raw : raw.slice(0, tableAt);

    const codes = new Set<string>();
    for (const match of block.matchAll(HTS8)) {
      // Chapter 99 headings appear throughout as cross-references; the
      // enumerated goods are everything else.
      if (!match[1].startsWith("99")) codes.add(match[0]);
    }
    if (codes.size < MIN_ENUMERATED) return;

    // The governing headings are named in the operative sentence that opens the
    // block ("The rates of duty in heading 9903.85.08 apply to …"). Headings
    // mentioned further down are usually exceptions and carve-outs, so taking
    // the whole block would attribute the wrong provision.
    const opening = block.slice(0, EXCERPT_CHARS * 2);
    const headings = [...new Set(Array.from(opening.matchAll(CH99), (m) => m[0]))];

    const noteRef = mark.note
      ? `${mark.note}(${mark.letter})`
      : `${nearestNoteNumber(text, mark.at) ?? "?"}(${mark.letter})`;
    const excerpt = tidy(block.slice(0, EXCERPT_CHARS));

    for (const code of codes) {
      const baseDigits = code.replace(/\D/g, "");
      const key = `${baseDigits}:${noteRef}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ baseDigits, noteRef, headings, excerpt });
    }
  });

  return rows;
}

/**
 * The numbered note a lettered subdivision belongs to.
 *
 * Subdivisions are published as bare "(k)" once the note number has been
 * stated, so the number has to be carried forward from the most recent
 * "19. (a)" style heading above it.
 */
function nearestNoteNumber(text: string, at: number): string | null {
  const window = text.slice(Math.max(0, at - 80_000), at);
  let found: string | null = null;
  for (const match of window.matchAll(/\n[ \t]*(\d{1,2})\.[ \t]*\([a-z]{1,3}\)[ \t]/g)) {
    found = match[1];
  }
  return found;
}
