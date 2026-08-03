/**
 * Which HS section each chapter belongs to.
 *
 * Section notes are binding under GRI 1 and routinely decide a classification
 * — Section XVI Note 2 (parts of machines) and Section XV Note 2 (parts of
 * general use) between them settle a large share of the contested cases. But
 * the notes are printed only at the head of the *first* chapter of each
 * section, so a chapter's own document usually does not contain them. Anyone
 * classifying an electrical machine in Chapter 85 needs Section XVI's notes,
 * which are published with Chapter 84.
 *
 * The mapping is part of the Harmonized System's structure rather than
 * something the tariff feed publishes, so it is stated here. Sections XXII
 * (Chapters 98-99) are U.S.-specific.
 */

const SECTION_RANGES: [section: string, first: number, last: number][] = [
  ["I", 1, 5],
  ["II", 6, 14],
  ["III", 15, 15],
  ["IV", 16, 24],
  ["V", 25, 27],
  ["VI", 28, 38],
  ["VII", 39, 40],
  ["VIII", 41, 43],
  ["IX", 44, 46],
  ["X", 47, 49],
  ["XI", 50, 63],
  ["XII", 64, 67],
  ["XIII", 68, 70],
  ["XIV", 71, 71],
  ["XV", 72, 83],
  ["XVI", 84, 85],
  ["XVII", 86, 89],
  ["XVIII", 90, 92],
  ["XIX", 93, 93],
  ["XX", 94, 96],
  ["XXI", 97, 97],
  ["XXII", 98, 99],
];

/** Section a chapter sits in, e.g. "85" -> "XVI". Null if out of range. */
export function sectionForChapter(chapter: string | number): string | null {
  const n = typeof chapter === "number" ? chapter : Number.parseInt(chapter, 10);
  if (!Number.isInteger(n)) return null;
  return SECTION_RANGES.find(([, first, last]) => n >= first && n <= last)?.[0] ?? null;
}

/** True when this chapter is the one whose document carries the section notes. */
export function isSectionOpeningChapter(chapter: string | number): boolean {
  const n = typeof chapter === "number" ? chapter : Number.parseInt(chapter, 10);
  return SECTION_RANGES.some(([, first]) => first === n);
}

/** Every chapter in a section, e.g. "XVI" -> [84, 85]. */
export function chaptersInSection(section: string): number[] {
  const range = SECTION_RANGES.find(([ref]) => ref === section.toUpperCase());
  if (!range) return [];
  const [, first, last] = range;
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

export const ALL_SECTIONS: readonly string[] = SECTION_RANGES.map(([ref]) => ref);
