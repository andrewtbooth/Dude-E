import { describe, expect, it } from "vitest";
import { parseChapter99Coverage } from "./chapter99";

/**
 * Shaped after the real note 19(k) block, which is how Section 232 derivative
 * aluminum coverage is actually expressed: the note names the Chapter 99
 * heading and then enumerates the base subheadings it reaches.
 */
const DERIVATIVE_ALUMINUM =
  "\n19. (k) The rates of duty in heading 9903.85.08 apply to all entries of " +
  "derivative aluminum products classifiable in the following HTSUS provisions, " +
  "unless the derivative aluminum product was processed in another country from " +
  "aluminum articles that were smelted and cast in the United States: " +
  "0402.99.68; 0402.99.70; 0402.99.90; 7610.10.00; 8302.10.30; 9403.20.00; " +
  "9403.99.90; 9506.51.40.\n";

describe("parseChapter99Coverage", () => {
  it("links enumerated subheadings to the note and heading that reach them", () => {
    const rows = parseChapter99Coverage(DERIVATIVE_ALUMINUM);
    const furniture = rows.find((row) => row.baseDigits === "94032000");

    expect(furniture).toBeDefined();
    expect(furniture?.noteRef).toBe("19(k)");
    expect(furniture?.headings).toEqual(["9903.85.08"]);
    expect(furniture?.excerpt).toContain("derivative aluminum products");
  });

  it("captures every subheading in the list", () => {
    const rows = parseChapter99Coverage(DERIVATIVE_ALUMINUM);
    expect(rows.map((row) => row.baseDigits).sort()).toEqual([
      "04029968",
      "04029970",
      "04029990",
      "76101000",
      "83021030",
      "94032000",
      "94039990",
      "95065140",
    ]);
  });

  it("carries a note number forward to bare lettered subdivisions", () => {
    // Notes state the number once and then continue "(l)", "(m)". Without
    // carrying it forward the reference is unusable for looking the note up.
    const rows = parseChapter99Coverage(
      DERIVATIVE_ALUMINUM +
        "\n(s) The rates of duty in heading 9903.85.15 apply to: " +
        "7601.10.30; 7601.10.60; 7604.10.10; 7604.29.10; 7606.11.30; 7616.99.51.\n",
    );
    expect(rows.find((row) => row.baseDigits === "76011030")?.noteRef).toBe("19(s)");
  });

  it("ignores prose that merely mentions a few subheadings", () => {
    // Notes discuss scope constantly. Only an enumerated list is coverage.
    const rows = parseChapter99Coverage(
      "\n5. (a) For the purposes of this note, goods of 8471.30.01 and " +
        "8517.13.00 shall be treated as originating.\n",
    );
    expect(rows).toEqual([]);
  });

  it("does not treat Chapter 99 cross-references as covered goods", () => {
    const rows = parseChapter99Coverage(
      "\n20. (b) Except as provided in headings 9903.88.05, 9903.88.06, " +
        "9903.88.07, 9903.88.08, 9903.88.10, 9903.88.11, the following are " +
        "covered: 8407.10.00; 8408.10.00; 8409.10.00; 8410.11.00; 8411.11.40.\n",
    );
    expect(rows.every((row) => !row.baseDigits.startsWith("99"))).toBe(true);
    expect(rows).toHaveLength(5);
  });

  it("stops a block at the tariff table that follows it", () => {
    // The last subdivision before a table used to run into it and treat every
    // code printed in the table's rows as enumerated — 667 spurious codes from
    // a single block of the live document.
    const rows = parseChapter99Coverage(
      "\n19. (k) The rates of duty in heading 9903.85.08 apply to: " +
        "7610.10.00; 8302.10.30; 9403.20.00; 9403.99.90; 9506.51.40. " +
        "Heading/ Subheading Stat Suffix Article Description Units of Quantity " +
        "Rates of Duty 0101.21.00 Purebred breeding horses 0102.29.40 Cattle " +
        "0103.10.00 Swine 0104.10.00 Sheep 0105.11.00 Chickens\n",
    );
    const codes = rows.map((row) => row.baseDigits);
    expect(codes).toContain("94032000");
    expect(codes).not.toContain("01012100");
    expect(codes).not.toContain("01051100");
  });

  it("records one row per note when several reach the same subheading", () => {
    const rows = parseChapter99Coverage(
      DERIVATIVE_ALUMINUM +
        "\n33. (a) As provided in heading 9903.96.01, the additional duties " +
        "shall not apply to civil aircraft parts: 7610.10.00; 8302.10.30; " +
        "9403.20.00; 9403.99.90; 8411.11.40.\n",
    );
    const furniture = rows.filter((row) => row.baseDigits === "94032000");
    expect(furniture.map((row) => row.noteRef).sort()).toEqual(["19(k)", "33(a)"]);
    // One of them is an exemption, which is exactly why the excerpt travels
    // with the reference instead of the index asserting a duty.
    expect(furniture.some((row) => row.excerpt.includes("shall not apply"))).toBe(true);
  });

  it("returns nothing rather than throwing on an empty or unstructured document", () => {
    expect(parseChapter99Coverage("")).toEqual([]);
    expect(parseChapter99Coverage("CHAPTER 99 TEMPORARY LEGISLATION")).toEqual([]);
  });
});
