import { describe, expect, it } from "vitest";
import {
  formatHtsNo,
  reportingNumberSource,
  levelOf,
  parseUsitcRows,
  toDigits,
} from "./parse";
import type { UsitcRawRow } from "./types";

/**
 * Shaped after real USITC `exportList` output for heading 8507 (electric
 * storage batteries): a heading row with no rates, a subheading, an 8-digit
 * rate line, and 10-digit statistical breakouts that publish no rates of
 * their own.
 */
const battery: UsitcRawRow[] = [
  {
    htsno: "8507",
    indent: "0",
    description:
      "Electric storage batteries, including separators therefor, whether or not rectangular (including square); parts thereof:",
    units: [],
    general: "",
    special: "",
    other: "",
  },
  {
    htsno: "8507.60",
    indent: "1",
    description: "Lithium-ion batteries:",
    units: [],
    general: "",
    special: "",
    other: "",
  },
  {
    htsno: "8507.60.00",
    indent: "2",
    description: "Other",
    units: ["No.", "kg"],
    general: "3.4%",
    special: "Free (A+,AU,BH,CL,CO,D,E,IL,JO,KR,MA,OM,P,PA,PE,S,SG)",
    other: "35%",
    footnotes: [{ value: "See 9903.88.03." }],
  },
  {
    htsno: "8507.60.00.10",
    indent: "3",
    description:
      "Of a kind used as the primary source of electrical power for electrically powered vehicles",
    units: ["No.", "kg"],
    general: "",
    special: "",
    other: "",
  },
  {
    htsno: "8507.60.00.20",
    indent: "3",
    description: "Other",
    units: ["No.", "kg"],
    general: "",
    special: "",
    other: "",
  },
];

describe("toDigits / formatHtsNo / levelOf", () => {
  it("round-trips canonical HTSUS formatting", () => {
    expect(toDigits("8507.60.00.20")).toBe("8507600020");
    expect(formatHtsNo("8507600020")).toBe("8507.60.00.20");
    expect(formatHtsNo("850760")).toBe("8507.60");
    expect(formatHtsNo("8507")).toBe("8507");
  });

  it("maps digit count to taxonomic level", () => {
    expect(levelOf("8507")).toBe(4);
    expect(levelOf("850760")).toBe(6);
    expect(levelOf("85076000")).toBe(8);
    expect(levelOf("8507600020")).toBe(10);
    expect(levelOf("")).toBe(0);
  });
});

describe("parseUsitcRows", () => {
  it("reconstructs the hierarchy from indent alone", () => {
    const { lines, warnings } = parseUsitcRows(battery);
    expect(warnings).toEqual([]);
    expect(lines).toHaveLength(5);

    const heading = lines[0];
    const subheading = lines[1];
    const rateLine = lines[2];
    const statLine = lines[3];

    expect(heading.parentId).toBeNull();
    expect(subheading.parentId).toBe(heading.id);
    expect(rateLine.parentId).toBe(subheading.id);
    expect(statLine.parentId).toBe(rateLine.id);
  });

  it("builds a full description path so bare 'Other' rows stay legible", () => {
    const { lines } = parseUsitcRows(battery);
    const other = lines.find((l) => l.htsNo === "8507.60.00.20");

    expect(other?.descriptionPath).toEqual([
      "Electric storage batteries, including separators therefor, whether or not rectangular (including square); parts thereof:",
      "Lithium-ion batteries:",
      "Other",
      "Other",
    ]);
  });

  it("inherits duty rates from the nearest ancestor that publishes them", () => {
    const { lines } = parseUsitcRows(battery);
    const stat = lines.find((l) => l.htsNo === "8507.60.00.10");

    expect(stat?.general).toBe("3.4%");
    expect(stat?.other).toBe("35%");
    // Provenance matters: the stat line did not publish this rate itself.
    expect(stat?.ratesInheritedFrom).toBe("8507.60.00");
  });

  it("leaves rates alone on a line that publishes its own", () => {
    const { lines } = parseUsitcRows(battery);
    const rateLine = lines.find((l) => l.htsNo === "8507.60.00");

    expect(rateLine?.general).toBe("3.4%");
    expect(rateLine?.ratesInheritedFrom).toBeNull();
  });

  it("marks the deepest published lines as reportable", () => {
    const { lines } = parseUsitcRows(battery);
    const reportable = lines.filter((l) => l.isReportable).map((l) => l.htsNo);
    expect(reportable).toEqual(["8507.60.00.10", "8507.60.00.20"]);
  });

  /**
   * Declarability is "nothing is published beneath it", not "it has ten digits"
   * — and separately, two chapters are never a classification at all.
   *
   * The ten-digit rule is right across most of the schedule and wrong exactly
   * where it costs most: 3,564 subheadings in the 2026 Rev 15 snapshot end at
   * eight digits, and the watch provisions of Chapter 91 were being rejected
   * with a message denying they could be declared, printed into the
   * determination.
   *
   * Chapters 98 and 99 are excluded for a different reason, which is about what
   * this application is for rather than about the shape of the line. It
   * produces the classification a product carries in a library and keeps across
   * every shipment. A Chapter 98 provision turns on the circumstances of one
   * importation — exported and returned, temporarily under bond, originating
   * under USMCA — so the same product can arrive under a different one, or
   * none, next month. Neither chapter can answer "what is this product".
   */
  describe("provisions that terminate above ten digits", () => {
    /** 9813.00.20 — TIB, samples for taking orders. No breakout beneath it. */
    const tib = [
      { htsno: "9813.00", indent: 0, description: "Articles admitted temporarily free of duty under bond:" },
      { htsno: "9813.00.20", indent: 1, description: "Samples solely for use in taking orders", general: "Free" },
      { htsno: "9813.00.25", indent: 1, description: "Articles solely for examination", general: "Free" },
    ];

    it("never treats a Chapter 98 provision as a classification", () => {
      // These are real leaves and they exist in the index — a run can look one
      // up and name it. What they cannot be is the answer to what the product
      // is, which is the only thing isReportable governs.
      const { lines } = parseUsitcRows(tib);
      expect(lines.filter((l) => l.isReportable)).toEqual([]);
      expect(lines.find((l) => l.htsNo === "9813.00.20")).toBeDefined();
    });

    /**
     * The watch provisions are the case the leaf rule was actually for: real
     * Chapter 1-97 classifications that the schedule stops at eight digits.
     */
    it("treats an 8-digit Chapter 91 leaf as declarable", () => {
      const { lines } = parseUsitcRows([
        { htsno: "9101.11", indent: 0, description: "With mechanical display only:" },
        { htsno: "9101.11.40", indent: 1, description: "Having no jewels or only one jewel in the movement" },
        { htsno: "9101.11.80", indent: 1, description: "Other" },
      ]);
      const reportable = lines.filter((l) => l.isReportable).map((l) => l.htsNo);
      expect(reportable).toEqual(["9101.11.40", "9101.11.80"]);
    });

    it("still refuses a line the schedule breaks out further", () => {
      const { lines } = parseUsitcRows([
        { htsno: "9101.11", indent: 0, description: "With mechanical display only:" },
        { htsno: "9101.11.40", indent: 1, description: "Having no jewels" },
      ]);
      expect(lines.find((l) => l.htsNo === "9101.11")?.isReportable).toBe(false);
    });

    /**
     * Chapter 99 is excluded whatever its shape. Its provisions are additional
     * duties declared *alongside* a Chapter 1-97 classification, never instead
     * of one, and they are checked on their own path. Admitting them here would
     * let a run answer "9903.88.03" to "what is this product", which is not a
     * classification at all.
     */
    it("never treats a Chapter 99 provision as a classification", () => {
      const { lines } = parseUsitcRows([
        { htsno: "9903.88", indent: 0, description: "Section 301 provisions:" },
        { htsno: "9903.88.03", indent: 1, description: "Articles of China", general: "The duty provided + 25%" },
      ]);
      expect(lines.every((l) => !l.isReportable)).toBe(true);
    });
  });

  it("carries chapter and heading down to descendants", () => {
    const { lines } = parseUsitcRows(battery);
    for (const line of lines) {
      expect(line.chapter).toBe("85");
      expect(line.heading).toBe("8507");
    }
  });

  it("preserves footnotes that point at Chapter 99 duties", () => {
    const { lines } = parseUsitcRows(battery);
    const rateLine = lines.find((l) => l.htsNo === "8507.60.00");
    expect(rateLine?.footnotes).toEqual(["See 9903.88.03."]);
  });

  it("pops stale deeper entries when indent decreases", () => {
    const rows: UsitcRawRow[] = [
      { htsno: "6109", indent: "0", description: "T-shirts:" },
      { htsno: "6109.10", indent: "1", description: "Of cotton:" },
      { htsno: "6109.10.00", indent: "2", description: "Men's or boys'" },
      { htsno: "6109.90", indent: "1", description: "Of other textile materials:" },
      { htsno: "6109.90.10", indent: "2", description: "Of man-made fibers" },
    ];
    const { lines } = parseUsitcRows(rows);
    const manMade = lines.find((l) => l.htsNo === "6109.90.10");

    // Must descend from 6109.90, not from the earlier 6109.10 branch.
    expect(manMade?.descriptionPath).toEqual([
      "T-shirts:",
      "Of other textile materials:",
      "Of man-made fibers",
    ]);
  });

  it("skips unreadable rows and reports them rather than guessing", () => {
    const rows: UsitcRawRow[] = [
      { htsno: "0101", indent: "0", description: "Live horses" },
      { htsno: "0101.21.00", indent: null, description: "Purebred" },
      { htsno: "not-a-number", indent: "1", description: "Nonsense" },
    ];
    const { lines, warnings } = parseUsitcRows(rows);

    expect(lines).toHaveLength(1);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/unreadable indent/);
    expect(warnings[1]).toMatch(/no digits/);
  });

  it("tolerates numeric indents and missing rate fields", () => {
    const rows: UsitcRawRow[] = [
      { htsno: "9403", indent: 0, description: "Other furniture:" },
      { htsno: "9403.20", indent: 1, description: "Other metal furniture:" },
    ];
    const { lines, warnings } = parseUsitcRows(rows);
    expect(warnings).toEqual([]);
    expect(lines[1].parentId).toBe(lines[0].id);
    expect(lines[1].general).toBe("");
  });
});

describe("USITC field-name quirks", () => {
  it("reads the misspelled addiitionalDuties key USITC also ships", () => {
    const { lines } = parseUsitcRows([
      {
        htsno: "9903.88.03",
        indent: "0",
        description: "Articles the product of China",
        addiitionalDuties: "25% ad valorem",
      },
    ]);
    expect(lines[0].additionalDuties).toBe("25% ad valorem");
  });

  it("prefers the correctly spelled key when both are present", () => {
    const { lines } = parseUsitcRows([
      {
        htsno: "9903.88.03",
        indent: "0",
        description: "Articles the product of China",
        additionalDuties: "correct",
        addiitionalDuties: "typo",
      },
    ]);
    expect(lines[0].additionalDuties).toBe("correct");
  });
});

describe("indent jumps", () => {
  /**
   * Shaped after the real 2826.90.90 rows, which go from indent 2 straight to
   * indent 4. Attaching such a row to root strips its ancestry, and because
   * duty rates are inherited from the nearest ancestor that publishes them,
   * the 10-digit statistical line ends up with no rate at all — while the
   * schedule plainly gives it 3.1%.
   */
  const fluorides: UsitcRawRow[] = [
    { htsno: "2826", indent: "0", description: "Fluorides; fluorosilicates:" },
    { htsno: "2826.90", indent: "1", description: "Other:" },
    {
      htsno: "2826.90.90",
      indent: "2",
      description: "Other",
      units: ["kg"],
      general: "3.1%",
      other: "25%",
    },
    {
      htsno: "2826.90.90.10",
      indent: "4",
      description: "Lithium hexafluorophosphate",
      units: ["kg"],
    },
    {
      htsno: "2826.90.90.90",
      indent: "4",
      description: "Other",
      units: ["kg"],
    },
  ];

  it("attaches a jumped row to the nearest ancestor, not to root", () => {
    const { lines } = parseUsitcRows(fluorides);
    const stat = lines.find((l) => l.htsNo === "2826.90.90.10");
    const rateLine = lines.find((l) => l.htsNo === "2826.90.90");
    expect(stat?.parentId).toBe(rateLine?.id);
  });

  it("still inherits the duty rate across the jump", () => {
    const { lines } = parseUsitcRows(fluorides);
    const stat = lines.find((l) => l.htsNo === "2826.90.90.10");
    expect(stat?.general).toBe("3.1%");
    expect(stat?.other).toBe("25%");
    expect(stat?.ratesInheritedFrom).toBe("2826.90.90");
  });

  it("keeps equal-indent rows as siblings, not as a chain", () => {
    const { lines } = parseUsitcRows(fluorides);
    const first = lines.find((l) => l.htsNo === "2826.90.90.10");
    const second = lines.find((l) => l.htsNo === "2826.90.90.90");
    expect(second?.parentId).toBe(first?.parentId);
  });

  it("builds the full description path across the jump", () => {
    const { lines } = parseUsitcRows(fluorides);
    const stat = lines.find((l) => l.htsNo === "2826.90.90.10");
    expect(stat?.descriptionPath).toEqual([
      "Fluorides; fluorosilicates:",
      "Other:",
      "Other",
      "Lithium hexafluorophosphate",
    ]);
  });

  it("stays quiet when the jump still lands on the row's own prefix", () => {
    // USITC numbers indents inconsistently, so jumps are routine and almost
    // always recover correctly — 2826.90.90.10 under 2826.90.90 is right,
    // whatever the indent column claimed. Warning on these produced 27
    // warnings on a real snapshot where all 27 were correct, which teaches an
    // operator that the warning count means nothing.
    const { warnings, lines } = parseUsitcRows(fluorides);
    expect(warnings).toEqual([]);
    const stat = lines.find((l) => l.htsNo === "2826.90.90.10");
    const parent = lines.find((l) => l.htsNo === "2826.90.90");
    expect(stat?.parentId).toBe(parent?.id);
  });

  it("warns when a jump attaches a row outside its own prefix", () => {
    // This is the case worth interrupting someone for: the row inherits a
    // description path and duty rates from a branch it does not belong to.
    const { warnings, lines } = parseUsitcRows([
      { htsno: "2826", indent: "0", description: "Fluorides:" },
      { htsno: "2826.90.90", indent: "1", description: "Other" },
      { htsno: "2827.20.00.10", indent: "3", description: "Calcium chloride" },
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/2827\.20\.00\.10/);
    expect(warnings[0]).toMatch(/not its prefix/);
    expect(warnings[0]).toMatch(/wrong\s+branch/);

    // The row is still kept — dropping it would hide a real tariff line.
    expect(lines.some((l) => l.htsNo === "2827.20.00.10")).toBe(true);
  });

  it("closes a deeper branch when indent drops back", () => {
    const { lines } = parseUsitcRows([
      ...fluorides,
      { htsno: "2827", indent: "0", description: "Chlorides:" },
      { htsno: "2827.20", indent: "1", description: "Calcium chloride" },
    ]);
    const calcium = lines.find((l) => l.htsNo === "2827.20");
    const chlorides = lines.find((l) => l.htsNo === "2827");
    expect(calcium?.parentId).toBe(chlorides?.id);
    expect(calcium?.descriptionPath).toEqual(["Chlorides:", "Calcium chloride"]);
  });
});

describe("reportingNumberSource", () => {
  /**
   * The question is where the ten-digit number is written, not whether one
   * exists. This used to answer the latter by counting digits, which made the
   * application state — on screen and in exported determinations — that the
   * schedule publishes no reporting number for the Chapter 91 watch
   * provisions. It publishes all 95 of them, in chapter statistical note 1, and
   * every one of those lines carries a footnote saying so.
   */
  it("reads a ten-digit statistical line off the line", () => {
    expect(reportingNumberSource("8507.60.00.20")).toBe("on_the_line");
  });

  it("reads an eight-digit subheading extended with .00 off the line", () => {
    expect(reportingNumberSource("9617.00.10.00")).toBe("on_the_line");
  });

  it("sends a watch provision to the chapter statistical note", () => {
    // The footnote is the signal, and it is the one 9101.11.40 actually
    // carries in the 2026 snapshot. All 95 short leaves in Chapters 1-97 carry
    // it and none of them is anything but Chapter 91.
    expect(
      reportingNumberSource("9101.11.40", [
        "See statistical note 1 to this chapter.",
      ]),
    ).toBe("chapter_statistical_note");
  });

  it("does not invent a note for a short line that carries none", () => {
    expect(reportingNumberSource("9813.00.20", [])).toBe("unpublished");
    // A footnote about something else is not a suffix scheme.
    expect(reportingNumberSource("9813.00.20", ["See 9903.88.03."])).toBe(
      "unpublished",
    );
  });

  it("does not consult footnotes once the number is already ten digits", () => {
    // 24 ten-digit leaves cite a statistical note for other reasons. Their
    // reporting number is still printed on the line.
    expect(
      reportingNumberSource("7113.19.50.21", [
        "See statistical note 1 to this chapter.",
      ]),
    ).toBe("on_the_line");
  });

  it("reads the digits, not the punctuation", () => {
    expect(reportingNumberSource("8507600020")).toBe("on_the_line");
    expect(reportingNumberSource("9101 11 40", ["See statistical note 1."])).toBe(
      "chapter_statistical_note",
    );
  });
});
