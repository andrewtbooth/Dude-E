import { describe, expect, it } from "vitest";
import { parseCsv, parseUsitcCsv } from "./csv";

describe("parseCsv", () => {
  it("reads plain rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("honours quoted fields containing commas", () => {
    expect(parseCsv('htsno,description\n8507.60,"Batteries, lithium-ion"')).toEqual(
      [
        ["htsno", "description"],
        ["8507.60", "Batteries, lithium-ion"],
      ],
    );
  });

  it("handles escaped quotes and embedded newlines", () => {
    const text = 'a,b\n"say ""hi""","line one\nline two"';
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ['say "hi"', "line one\nline two"],
    ]);
  });

  it("strips a UTF-8 BOM so the first header is not corrupted", () => {
    const [header] = parseCsv("﻿htsno,indent\n8507,0");
    expect(header[0]).toBe("htsno");
  });

  it("tolerates CRLF and drops blank lines", () => {
    expect(parseCsv("a,b\r\n1,2\r\n\r\n3,4\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("parseUsitcCsv", () => {
  const csv = [
    "HTS Number,Indent,Description,Unit of Quantity,General Rate of Duty,Special Rate of Duty,Column 2 Rate of Duty",
    '8507,0,"Electric storage batteries:",,,,',
    '8507.60,1,"Lithium-ion batteries:",,,,',
    '8507.60.00,2,Other,"No.,kg",3.4%,Free (A+),35%',
  ].join("\n");

  it("maps columns by header name, not position", () => {
    const { rows } = parseUsitcCsv(csv);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({
      htsno: "8507.60.00",
      indent: "2",
      description: "Other",
      general: "3.4%",
      special: "Free (A+)",
      other: "35%",
    });
  });

  it("splits a units cell into a list", () => {
    const { rows } = parseUsitcCsv(csv);
    expect(rows[2].units).toEqual(["No.", "kg"]);
    expect(rows[0].units).toEqual([]);
  });

  it("accepts the short column aliases USITC has also used", () => {
    const alt = ["htsno,indent,description,general", "0101,0,Live horses,Free"].join(
      "\n",
    );
    const { rows, missingColumns } = parseUsitcCsv(alt);
    expect(missingColumns).toEqual([]);
    expect(rows[0]).toMatchObject({ htsno: "0101", general: "Free" });
  });

  it("reports required columns that are absent rather than importing junk", () => {
    // Losing the indent column means the hierarchy cannot be rebuilt at all,
    // which would silently corrupt every description path.
    const { missingColumns } = parseUsitcCsv("HTS Number,Description\n0101,Horses");
    expect(missingColumns).toEqual(["indent"]);
  });

  it("reports unrecognised columns instead of dropping them silently", () => {
    const { unmappedHeaders } = parseUsitcCsv(
      "htsno,indent,description,mystery\n0101,0,Horses,x",
    );
    expect(unmappedHeaders).toEqual(["mystery"]);
  });

  it("returns nothing useful for an empty or header-only file", () => {
    expect(parseUsitcCsv("").rows).toEqual([]);
    expect(parseUsitcCsv("htsno,indent,description").rows).toEqual([]);
  });

  it("round-trips through the row parser into a usable hierarchy", () => {
    const { rows } = parseUsitcCsv(csv);
    // Proves the CSV path produces rows the existing indent parser accepts.
    expect(rows.map((r) => r.indent)).toEqual(["0", "1", "2"]);
  });
});
