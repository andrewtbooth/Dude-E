import { describe, expect, it } from "vitest";
import {
  extractRevision,
  notesSectionOf,
  parseConcordance,
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

describe("parseConcordance", () => {
  it("reads a tab-delimited Census concordance", () => {
    const text = [
      "HTS\tSCHEDULE_B\tDESCRIPTION",
      "8507600020\t8507600000\tLithium-ion storage batteries",
      "9617001000\t9617000000\tVacuum flasks and other vacuum vessels",
    ].join("\n");

    expect(parseConcordance(text)).toEqual([
      {
        hts10: "8507600020",
        scheduleB: "8507.60.0000",
        description: "Lithium-ion storage batteries",
      },
      {
        hts10: "9617001000",
        scheduleB: "9617.00.0000",
        description: "Vacuum flasks and other vacuum vessels",
      },
    ]);
  });

  it("reads comma-delimited and dotted codes", () => {
    const text = '"8507.60.00.20","8507.60.0000","Lithium-ion batteries"';
    expect(parseConcordance(text)).toEqual([
      {
        hts10: "8507600020",
        scheduleB: "8507.60.0000",
        description: "Lithium-ion batteries",
      },
    ]);
  });

  it("skips header rows and lines without two code columns", () => {
    const text = [
      "HTS Number,Schedule B Number,Commodity Description",
      "8507600020,8507600000,Batteries",
      "not a data row at all",
      "8507600010,,missing schedule b",
    ].join("\n");

    const entries = parseConcordance(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].hts10).toBe("8507600020");
  });

  it("de-duplicates repeated pairs", () => {
    const text = [
      "8507600020\t8507600000\tBatteries",
      "8507600020\t8507600000\tBatteries",
    ].join("\n");
    expect(parseConcordance(text)).toHaveLength(1);
  });

  it("returns an empty list rather than throwing on junk", () => {
    expect(parseConcordance("")).toEqual([]);
    expect(parseConcordance("<html>404</html>")).toEqual([]);
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
