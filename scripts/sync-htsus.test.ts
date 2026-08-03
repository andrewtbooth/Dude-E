import { describe, expect, it } from "vitest";
import { splitSectionNotes, tableHeaderIndex } from "../src/lib/hts/notes";
import {
  ALL_CHAPTERS,
  describeChapters,
  extractRevision,
  partialRevisionLabel,
  notesSectionOf,
  scheduleBCoverage,
  scheduleBEditionCandidates,
  scheduleBUrl,
  stripMarkup,
} from "./sync-htsus";

describe("extractRevision", () => {
  it("pulls the revision label out of a JSON release listing", () => {
    const payload = JSON.stringify([
      { name: "2026 HTS Revision 13", date: "07/28/2026" },
      { name: "2026 HTS Revision 12", date: "07/21/2026" },
    ]);
    expect(extractRevision(payload)).toEqual({
      revision: "2026 HTS Revision 13",
      publishedDate: "2026-07-28",
    });
  });

  it("handles an ISO date", () => {
    expect(
      extractRevision('{"release":"2026 HTS Revision 9","published":"2026-06-02"}'),
    ).toEqual({ revision: "2026 HTS Revision 9", publishedDate: "2026-06-02" });
  });

  it("handles HTML and tolerates a missing date", () => {
    expect(extractRevision("<h1>2025 HTS Revision 4</h1>")).toEqual({
      revision: "2025 HTS Revision 4",
      publishedDate: null,
    });
  });

  it("returns null when there is no revision label to find", () => {
    // Callers must fail loudly rather than stamp a guessed version.
    expect(extractRevision("<html><body>Service unavailable</body></html>")).toBeNull();
    expect(extractRevision("")).toBeNull();
  });
});

describe("stripMarkup", () => {
  it("removes tags and decodes entities", () => {
    expect(
      stripMarkup(
        "<div><p>Chapter 96 &mdash; notes</p><p>Does not cover parts &amp; accessories</p></div>",
      ),
    ).toBe("Chapter 96 &mdash; notes Does not cover parts & accessories");
  });

  it("drops script and style content entirely", () => {
    expect(
      stripMarkup("<style>p{color:red}</style><p>Note 1.</p><script>x=1</script>"),
    ).toBe("Note 1.");
  });
});

describe("notesSectionOf", () => {
  it("cuts the tariff table off, keeping only the notes", () => {
    // Each chapter PDF is notes followed by the full tariff table. We already
    // hold the table as structured rows, so keeping it here would duplicate
    // tens of thousands of characters and push the notes out of the tool's
    // output window.
    const text =
      "CHAPTER 96 MISCELLANEOUS MANUFACTURED ARTICLES Notes 1. This chapter does not cover: " +
      "(d) Parts of general use, as defined in note 2 to section XV. " +
      "x".repeat(200) +
      "Rates of Duty Article Description Heading/ 9601 Worked ivory 3.7%";

    const notes = notesSectionOf(text);
    expect(notes).toContain("This chapter does not cover");
    expect(notes).toContain("Parts of general use");
    expect(notes).not.toContain("Worked ivory");
    expect(notes).not.toContain("Rates of Duty");
  });

  it("keeps the whole document when no table follows", () => {
    // The General Notes PDF carries the GRIs and no tariff table.
    const text = "GENERAL RULES OF INTERPRETATION 1. ... terms of the headings ...";
    expect(notesSectionOf(text)).toBe(text);
  });

  it("ignores a marker appearing too early to be the table header", () => {
    const text =
      "CHAPTER 1 Notes 1. Rates of Duty are set out in the table below. " +
      "y".repeat(300) +
      "Rates of Duty Article Description Heading/ 0101 Live horses";
    const notes = notesSectionOf(text);
    expect(notes).toContain("Notes 1.");
    expect(notes).not.toContain("Live horses");
  });

  it("collapses whitespace from PDF extraction", () => {
    expect(notesSectionOf("Notes   1.\n\n  This\tchapter")).toBe(
      "Notes 1. This chapter",
    );
  });
});

describe("Schedule B edition discovery", () => {
  it("builds the published URL for an edition", () => {
    expect(scheduleBUrl("2026")).toBe(
      "https://www.census.gov/foreign-trade/schedules/b/2026/exp-code.txt",
    );
  });

  it("probes next year first, because Census publishes ahead of the year", () => {
    // In December 2026 the 2027 edition is already up; in January it is the
    // one in force. Trying it first costs one request and avoids stamping a
    // superseded edition on determinations.
    expect(scheduleBEditionCandidates(new Date("2026-12-15T00:00:00Z"))).toEqual([
      "2027",
      "2026",
      "2025",
    ]);
  });
});

describe("scheduleBCoverage", () => {
  const htsLine = (digits: string, isReportable = true) =>
    ({ digits, isReportable }) as never;
  const sbLine = (hs6: string) => ({ hs6 }) as never;

  it("counts reportable lines that reach an export code at HS-6", () => {
    const coverage = scheduleBCoverage(
      [
        htsLine("8507600010"),
        htsLine("8507600020"),
        htsLine("9801001000"),
        // Non-reportable lines are not classifiable and must not dilute the ratio.
        htsLine("850760", false),
      ],
      [sbLine("850760")],
    );

    expect(coverage.reportable).toBe(3);
    expect(coverage.covered).toBe(2);
    expect(coverage.orphanHs6).toEqual(["980100"]);
  });

  it("reports no orphans when every subheading is covered", () => {
    const coverage = scheduleBCoverage([htsLine("8507600010")], [sbLine("850760")]);
    expect(coverage.orphanHs6).toEqual([]);
  });
});

describe("partial-pull labelling", () => {
  it("collapses consecutive chapters into ranges", () => {
    expect(describeChapters([84, 85, 86, 96])).toBe("84-86, 96");
    expect(describeChapters([96, 84, 85])).toBe("84-85, 96");
    expect(describeChapters([1])).toBe("01");
  });

  it("falls back to a count once the list stops being readable", () => {
    // The label is stamped on determinations and shown in the masthead, so it
    // has to stay legible whatever selection someone passes.
    const scattered = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25];
    expect(describeChapters(scattered)).toBe("13 of 99");
  });

  it("de-duplicates and sorts", () => {
    expect(describeChapters([85, 84, 85])).toBe("84-85");
  });

  it("tags the revision so the partial snapshot cannot pass as the edition", () => {
    // This is the whole mechanism: manifest.revision is the single source of
    // the version stamp, so tagging it here propagates to the masthead, the
    // Analysis and Determination rows, the PDF header, and the directory slug.
    expect(partialRevisionLabel("2026 HTS Revision 14", [84, 85, 96])).toBe(
      "2026 HTS Revision 14 (PARTIAL — chapters 84-85, 96)",
    );
  });

  it("gives a partial pull a different directory slug than the full edition", () => {
    const slug = (revision: string) =>
      revision.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    expect(slug(partialRevisionLabel("2026 HTS Revision 14", [96]))).not.toBe(
      slug("2026 HTS Revision 14"),
    );
  });

  it("covers every chapter USITC publishes", () => {
    expect(ALL_CHAPTERS).toHaveLength(99);
    expect(ALL_CHAPTERS.at(0)).toBe(1);
    expect(ALL_CHAPTERS.at(-1)).toBe(99);
  });
});

describe("tableHeaderIndex", () => {
  it("does not cut on a lone marker that occurs in prose", () => {
    // "Rates of Duty" is the literal title of General Note 3, and chapter notes
    // quote these phrases. Cutting on a single hit truncated the General Notes
    // at General Note 3, Chapter 91 mid-sentence, and Chapter 23 mid-table.
    const text =
      "CHAPTER 91 Notes 1. The rates of duty for these articles are set out " +
      "below. See Rates of Duty column 1. " +
      "z".repeat(400) +
      "and the note continues to its end.";
    expect(tableHeaderIndex(text)).toBeNull();
    expect(notesSectionOf(text)).toContain("the note continues to its end");
  });

  it("cuts where the column headings actually run together", () => {
    const text =
      "CHAPTER 96 Notes 1. This chapter does not cover: " +
      "x".repeat(300) +
      "Heading/ Subheading Stat Suffix Article Description Units of Quantity " +
      "Rates of Duty 9601 Worked ivory 3.7%";
    const notes = notesSectionOf(text);
    expect(notes).toContain("This chapter does not cover");
    expect(notes).not.toContain("Worked ivory");
    expect(notes).not.toContain("Article Description");
  });

  it("needs three distinct headings, not two", () => {
    const text = `Notes 1. ${"y".repeat(300)}Article Description and Rates of Duty are discussed above.`;
    expect(tableHeaderIndex(text)).toBeNull();
  });
});

describe("notesSectionOf — General Notes", () => {
  it("stops at General Note 3 rather than keeping the FTA annexes", () => {
    // The live document is ~2.7 MB: GRIs, the Additional U.S. Rules, GN 1-2,
    // then tariff annexes for every trade agreement. Keeping all of it is
    // unusable and implies a preference analysis this tool does not do.
    const text =
      "GENERAL RULES OF INTERPRETATION 1. Classification shall be determined " +
      "according to the terms of the headings. " +
      "w".repeat(300) +
      "Rates of Duty 3. Rates of duty in the tariff schedule. USMCA originating goods";
    const notes = notesSectionOf(text, "general");
    expect(notes).toContain("terms of the headings");
    expect(notes).not.toContain("USMCA");
  });

  it("keeps the whole document when the boundary is absent", () => {
    const text = "GENERAL RULES OF INTERPRETATION 1. ... terms of the headings ...";
    expect(notesSectionOf(text, "general")).toBe(text);
  });
});

describe("splitSectionNotes", () => {
  it("splits the section block from the chapter that carries it", () => {
    const text =
      "SECTION XVI MACHINERY AND MECHANICAL APPLIANCES Notes 1. This section " +
      "does not cover: (a) transmission belts of chapter 39 or of vulcanized " +
      "rubber. 2. Parts of machines are to be classified according to the " +
      "following rules. CHAPTER 84 NUCLEAR REACTORS Notes 1. This chapter does " +
      "not cover millstones.";
    const { section, chapter } = splitSectionNotes(text);
    expect(section?.ref).toBe("XVI");
    expect(section?.body).toContain("Parts of machines");
    expect(section?.body).not.toContain("millstones");
    expect(chapter).toContain("millstones");
    expect(chapter).not.toContain("Parts of machines");
  });

  it("does not cut at a lower-case prose reference to another chapter", () => {
    // The structural headings are capitalised; the notes refer to other
    // chapters in lower case. Matching case-insensitively kept only Section
    // XVI's 331-character title and discarded Note 2, the parts rule.
    const { section } = splitSectionNotes(
      "SECTION XVI MACHINERY Notes 1. This section does not cover goods of " +
        "chapter 39 or chapter 40. 2. Parts solely or principally used with a " +
        "machine are classified with that machine. CHAPTER 84 REACTORS",
    );
    expect(section?.body).toContain("solely or principally");
  });

  it("says a section has no notes rather than storing its title page", () => {
    const { section } = splitSectionNotes(
      "SECTION V MINERAL PRODUCTS V-1 Harmonized Tariff Schedule of the " +
        "United States CHAPTER 25 SALT; SULFUR Notes 1. Except where...",
    );
    expect(section?.ref).toBe("V");
    expect(section?.body).toContain("has no section notes");
  });

  it("leaves a chapter that does not open a section alone", () => {
    const text = "CHAPTER 85 ELECTRICAL MACHINERY Notes 1. This chapter does not cover...";
    const { section, chapter } = splitSectionNotes(text);
    expect(section).toBeNull();
    expect(chapter).toBe(text);
  });
});
