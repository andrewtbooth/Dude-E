import type { UsitcRawRow } from "./types";

/**
 * Reader for a USITC CSV export.
 *
 * The browser export at hts.usitc.gov/export offers CSV, JSON and Excel. JSON
 * is the cleaner input, but CSV is what people tend to click, so both are
 * accepted. Columns are matched by header name rather than position, because
 * USITC has reordered and renamed them between editions.
 */

/** Split CSV text into rows of fields, honouring quotes and embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip a UTF-8 BOM; Excel-produced exports frequently carry one and it
  // would otherwise corrupt the first header name.
  const input = text.replace(/^﻿/, "");

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((value) => value.trim() !== ""));
}

/** Header aliases seen across USITC editions, normalised to our field names. */
const COLUMN_ALIASES: Record<string, keyof UsitcRawRow> = {
  htsno: "htsno",
  "hts number": "htsno",
  "hts no": "htsno",
  hts: "htsno",
  indent: "indent",
  description: "description",
  superior: "superior",
  unit: "units",
  units: "units",
  "unit of quantity": "units",
  general: "general",
  "general rate of duty": "general",
  "col1 general": "general",
  special: "special",
  "special rate of duty": "special",
  "col1 special": "special",
  other: "other",
  "column 2 rate of duty": "other",
  col2: "other",
  "quota quantity": "quotaQuantity",
  quotaquantity: "quotaQuantity",
  "additional duties": "additionalDuties",
  additionalduties: "additionalDuties",
  footnotes: "footnotes",
};

function normaliseHeader(header: string): keyof UsitcRawRow | null {
  const key = header.trim().toLowerCase().replace(/\s+/g, " ");
  return COLUMN_ALIASES[key] ?? null;
}

export interface CsvParseResult {
  rows: UsitcRawRow[];
  /** Headers present in the file that we did not recognise. */
  unmappedHeaders: string[];
  /** Fields we need but could not find a column for. */
  missingColumns: string[];
}

export function parseUsitcCsv(text: string): CsvParseResult {
  const table = parseCsv(text);
  if (table.length < 2) {
    return {
      rows: [],
      unmappedHeaders: [],
      missingColumns: ["htsno", "indent", "description"],
    };
  }

  const header = table[0];
  const mapping = header.map(normaliseHeader);
  const unmappedHeaders = header.filter((_, i) => mapping[i] === null);

  // htsno may legitimately be blank on header rows, but the column must exist,
  // and indent must exist or the hierarchy cannot be rebuilt at all.
  const present = new Set(mapping.filter(Boolean) as string[]);
  const missingColumns = ["htsno", "indent", "description"].filter(
    (field) => !present.has(field),
  );

  const rows: UsitcRawRow[] = [];
  for (const line of table.slice(1)) {
    const row: UsitcRawRow = {};
    mapping.forEach((field, index) => {
      if (!field) return;
      const value = (line[index] ?? "").trim();
      if (field === "units") {
        // Units arrive as a single cell such as "No.,kg".
        row.units = value ? value.split(/[,;]/).map((v) => v.trim()).filter(Boolean) : [];
      } else if (field === "footnotes") {
        row.footnotes = value ? [value] : [];
      } else {
        (row as Record<string, unknown>)[field] = value;
      }
    });
    rows.push(row);
  }

  return { rows, unmappedHeaders, missingColumns };
}
