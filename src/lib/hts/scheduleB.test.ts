import { describe, expect, it } from "vitest";
import { formatScheduleB, parseScheduleB, scheduleBHs6 } from "./scheduleB";

/**
 * Records copied byte for byte out of Census's 2026 `exp-code.txt`, so the
 * column offsets are exercised against the real thing rather than against a
 * hand-built line that happens to agree with our own arithmetic.
 */
const REAL_RECORDS = [
  "0101210000    HORSES, PUREBRED BREEDING, LIVE                        HORSES, PUREBRED BREEDING, LIVE                                                                                                                            NO              00150     10140     0    112920     00",
  "8507600000    LITHIUM ION BATTERIES                                  LITHIUM ION BATTERIES                                                                                                                                      NO              77812     20005     1    335910     00",
  "9617002000    FLASK AND OTHER VESSELS, COMPLETE WITH CASES           FLASK AND OTHER VESSELS, COMPLETE WITH CASES                                                                                                               NO              89997     41050     1    332439     00",
].join("\n");

describe("parseScheduleB", () => {
  it("reads every field at its published offset", () => {
    const { lines, warnings } = parseScheduleB(REAL_RECORDS);
    expect(warnings).toEqual([]);
    expect(lines).toHaveLength(3);

    expect(lines[1]).toEqual({
      code: "8507600000",
      htsNo: "8507.60.00.00",
      hs6: "850760",
      chapter: "85",
      description: "LITHIUM ION BATTERIES",
      shortDescription: "LITHIUM ION BATTERIES",
      units: ["NO"],
      sitc: "77812",
      endUse: "20005",
      naics: "335910",
      isAgricultural: true,
      hiTech: "00",
    });
  });

  it("reads the USDA flag as a flag, not as a code", () => {
    const { lines } = parseScheduleB(REAL_RECORDS);
    // Column 261 is "0" for horses and "1" for batteries in the live file.
    expect(lines[0].isAgricultural).toBe(false);
    expect(lines[1].isAgricultural).toBe(true);
  });

  it("skips a line whose code is not ten digits and says so", () => {
    const { lines, warnings } = parseScheduleB(
      ["SCHEDULE B 2026 EXPORT CODES", REAL_RECORDS.split("\n")[0]].join("\n"),
    );
    expect(lines).toHaveLength(1);
    expect(warnings[0]).toMatch(/does not begin with a 10-digit code/);
  });

  it("summarises rather than emitting one warning per bad line", () => {
    // A layout change would otherwise produce thousands of identical warnings
    // and bury everything else in the manifest.
    const junk = Array.from({ length: 50 }, () => "not a record").join("\n");
    const { lines, warnings } = parseScheduleB(junk);
    expect(lines).toHaveLength(0);
    expect(warnings).toHaveLength(4);
    expect(warnings[3]).toMatch(/50 Schedule B lines in total/);
  });

  it("tolerates a truncated trailing field rather than losing the record", () => {
    const truncated = REAL_RECORDS.split("\n")[1].slice(0, 240);
    const { lines } = parseScheduleB(truncated);
    expect(lines).toHaveLength(1);
    expect(lines[0].code).toBe("8507600000");
    expect(lines[0].description).toBe("LITHIUM ION BATTERIES");
    expect(lines[0].naics).toBeNull();
  });

  it("de-duplicates repeated codes", () => {
    const row = REAL_RECORDS.split("\n")[0];
    expect(parseScheduleB([row, row].join("\n")).lines).toHaveLength(1);
  });

  it("returns nothing rather than throwing on an empty or HTML body", () => {
    expect(parseScheduleB("").lines).toEqual([]);
    expect(parseScheduleB("<html><body>404</body></html>").lines).toEqual([]);
  });
});

describe("formatScheduleB / scheduleBHs6", () => {
  it("dots a bare code", () => {
    expect(formatScheduleB("9617002000")).toBe("9617.00.20.00");
  });

  it("leaves anything that is not ten digits alone", () => {
    expect(formatScheduleB("961700")).toBe("961700");
  });

  it("takes the HS subheading from either form", () => {
    expect(scheduleBHs6("9617.00.20.00")).toBe("961700");
    expect(scheduleBHs6("9617002000")).toBe("961700");
  });
});
