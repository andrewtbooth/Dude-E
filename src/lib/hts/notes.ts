/**
 * Where a notes PDF stops being notes.
 *
 * Shared because two callers need the same boundary: the sync trims each
 * chapter document at its tariff table, and the Chapter 99 coverage parser
 * bounds each note subdivision at the table that follows it. Getting this
 * wrong in the second case is not cosmetic — an unbounded block runs into the
 * table and treats every code printed there as an enumerated subheading.
 */

/**
 * Column headings of the tariff table that follows the notes in each PDF.
 *
 * Matching any one of these is not safe. "Rates of Duty" is the literal title
 * of General Note 3, and chapter notes quote these phrases in prose and in
 * quota tables — cutting on a lone hit truncated the General Notes at General
 * Note 3 (losing every FTA rule of origin), Chapter 91 mid-sentence, and
 * Chapter 23 mid-quota-table. The real header is several of these appearing
 * together, which prose never does.
 */
const TABLE_HEADER_MARKERS = [
  "Heading/",
  "Stat Suffix",
  "Article Description",
  "Unit of Quantity",
  "Units of Quantity",
  "Rates of Duty",
];

/** How close the headings must sit to count as one header row. */
const HEADER_WINDOW = 400;
/** Below this the "header" is the document's own title block, not the table. */
export const MIN_NOTES_LENGTH = 200;

/**
 * Index where the tariff table's column header starts, or null if absent.
 *
 * `minIndex` guards against matching a document's own title block, which is
 * why it defaults to a couple of hundred characters. Callers bounding a
 * *fragment* rather than a document should pass 0: a note subdivision can be
 * two lines long and still be followed immediately by a table, and applying
 * the document minimum there lets the table's rows leak into the fragment.
 */
export function tableHeaderIndex(
  text: string,
  minIndex: number = MIN_NOTES_LENGTH,
): number | null {
  const hits: { index: number; marker: string }[] = [];
  for (const marker of TABLE_HEADER_MARKERS) {
    for (
      let at = text.indexOf(marker);
      at !== -1;
      at = text.indexOf(marker, at + 1)
    ) {
      hits.push({ index: at, marker });
    }
  }
  hits.sort((a, b) => a.index - b.index);

  for (let i = 0; i < hits.length; i += 1) {
    if (hits[i].index <= minIndex) continue;
    const nearby = new Set<string>();
    for (
      let j = i;
      j < hits.length && hits[j].index - hits[i].index <= HEADER_WINDOW;
      j += 1
    ) {
      nearby.add(hits[j].marker);
    }
    if (nearby.size >= 3) return hits[i].index;
  }
  return null;
}

/**
 * Split a chapter's notes into the section notes it may carry and its own.
 *
 * USITC publishes no section-notes document — every filename we tried returns
 * an error — but the section's notes are printed at the head of the section's
 * first chapter, before that chapter's own heading. Chapter 84's document opens
 * "SECTION XVI MACHINERY AND MECHANICAL APPLIANCES … Notes 1. This section does
 * not cover: …" and only then reaches "CHAPTER 84".
 *
 * Splitting them here is what lets Section XVI's notes be retrieved when
 * classifying in Chapter 85, whose own document does not contain them. Without
 * it, every `hts_notes(kind:"section")` call fails and the binding note that
 * decides most parts classifications is unreachable.
 */
export function splitSectionNotes(text: string): {
  section: { ref: string; body: string } | null;
  chapter: string;
} {
  // Case-sensitive on purpose. The structural headings are set in capitals
  // ("SECTION XVI", "CHAPTER 84"), while the notes themselves refer to other
  // chapters in lower case ("goods of chapter 39"). Matching case-insensitively
  // cut Section XVI's block at the first such prose reference, keeping only the
  // 331-character title and discarding Note 2 — the parts rule that decides
  // most of the section's contested classifications.
  const opening = /^\s*SECTION\s+([IVXL]+)\b/.exec(text);
  if (!opening) return { section: null, chapter: text };

  const chapterAt = text.search(/\bCHAPTER\s+\d+\b/);
  if (chapterAt <= 0) return { section: null, chapter: text };

  const ref = opening[1].toUpperCase();
  const body = text.slice(0, chapterAt).trim();
  const chapter = text.slice(chapterAt).trim();

  // Several sections genuinely have no notes — V, XIII, XIX, XX and XXI carry
  // only a title page. Storing that page verbatim would let it read as
  // authority that was consulted and found silent on the point, which is not
  // the same thing. Record the fact instead, so the tool can state it plainly
  // rather than the model inferring it from a page header.
  const hasNotes = /\bNotes?\s+\d+\./.test(body);
  return {
    section: {
      ref,
      body: hasNotes
        ? body
        : `Section ${ref} has no section notes in this revision. ` +
          `Classification in this section turns on the chapter notes and the ` +
          `heading terms alone.`,
    },
    chapter,
  };
}

