import { describe, expect, it } from "vitest";
import { formatHtsNo, levelOf, parseUsitcRows, toDigits } from "./parse";
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

  it("marks only 10-digit lines as reportable", () => {
    const { lines } = parseUsitcRows(battery);
    const reportable = lines.filter((l) => l.isReportable).map((l) => l.htsNo);
    expect(reportable).toEqual(["8507.60.00.10", "8507.60.00.20"]);
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
