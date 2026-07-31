import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import {
  getAncestors,
  getChapter99Candidates,
  getGeneralRules,
  getNotes,
  getScheduleB,
  getSubtree,
  lookupExact,
  searchHts,
} from "../hts/store";
import type { HtsLine } from "../hts/types";

/**
 * Tools the classification agent runs against the local HTSUS snapshot.
 *
 * Output is formatted as compact text rather than JSON: the model reads these
 * as tariff extracts, and the indented-path form mirrors how the printed
 * schedule actually reads, which makes GRI 6 sibling comparison legible.
 *
 * Every tool reports "not found" as a distinct, explicit outcome. That matters
 * more than it looks — the agent must be able to tell "this chapter has no
 * notes" apart from "the notes could not be retrieved", and "this code does
 * not exist in this revision" apart from "the lookup failed". Collapsing those
 * into an empty result is how a model ends up quietly inventing a code.
 */

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatRates(line: HtsLine): string {
  const parts: string[] = [];
  if (line.general) parts.push(`General: ${line.general}`);
  if (line.special) parts.push(`Special: ${line.special}`);
  if (line.other) parts.push(`Column 2: ${line.other}`);
  if (line.ratesInheritedFrom) {
    parts.push(`(rates published on ${line.ratesInheritedFrom}, inherited)`);
  }
  return parts.length ? parts.join(" | ") : "no rates published on this line";
}

function formatLine(line: HtsLine): string {
  const lines: string[] = [];
  lines.push(`${line.htsNo || "(no number)"}  ${line.description}`);
  lines.push(`  path: ${line.descriptionPath.filter(Boolean).join(" > ")}`);
  lines.push(`  ${formatRates(line)}`);
  if (line.units.length) lines.push(`  units: ${line.units.join(", ")}`);
  if (line.footnotes.length) {
    lines.push(`  footnotes: ${line.footnotes.join(" ")}`);
  }
  if (line.quotaQuantity) lines.push(`  quota: ${line.quotaQuantity}`);
  lines.push(
    `  reportable (10-digit, declarable): ${line.isReportable ? "yes" : "no"}`,
  );
  return lines.join("\n");
}

function formatTreeRow(line: HtsLine): string {
  const indent = "  ".repeat(Math.max(0, line.indent));
  const number = line.htsNo ? `${line.htsNo}  ` : "";
  const rates = line.general ? `   [${formatRates(line)}]` : "";
  const units = line.units.length ? `  {${line.units.join(", ")}}` : "";
  return `${indent}${number}${line.description}${units}${rates}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n\n[truncated at ${max} characters — request a narrower reference for the rest]`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const htsSearchTool = betaZodTool({
  name: "hts_search",
  description:
    "Full-text search over the active HTSUS revision. Use it to find candidate headings from a product's words, then hts_lookup or hts_subtree to examine them properly. Search is a starting point, not evidence — never cite a code you only saw here.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Natural-language terms. Prefer tariff vocabulary ('vacuum vessel') alongside plain words ('thermos'); run several searches rather than one long one.",
      ),
    chapter: z
      .string()
      .nullable()
      .describe("Two-digit chapter to restrict to, e.g. '85'. Null for all."),
    reportable_only: z
      .boolean()
      .describe("True to return only 10-digit statistical lines."),
    limit: z.number().int().describe("Max results, 1-100. 25 is a good default."),
  }),
  run: ({ query, chapter, reportable_only, limit }) => {
    const hits = searchHts(query, {
      chapter: chapter ?? undefined,
      reportableOnly: reportable_only,
      limit,
    });

    if (hits.length === 0) {
      return `No matches for "${query}"${chapter ? ` in chapter ${chapter}` : ""}. Try different terms, drop the chapter filter, or search the tariff's own wording rather than the trade name.`;
    }

    return hits
      .map((hit) => {
        const path = hit.descriptionPath.filter(Boolean).join(" > ");
        const rate = hit.general ? `  [General: ${hit.general}]` : "";
        return `${hit.htsNo}${hit.isReportable ? " (10-digit)" : ""}  ${path}${rate}`;
      })
      .join("\n");
  },
});

export const htsLookupTool = betaZodTool({
  name: "hts_lookup",
  description:
    "Look up one HTS number in the active revision and return it with its full ancestry, duty rates, units, and footnotes. This is the verification step: every code you name in your answer must have been confirmed here first.",
  inputSchema: z.object({
    hts_code: z
      .string()
      .describe("HTS number, dotted or bare, e.g. '8507.60.00.20' or '8507600020'."),
  }),
  run: ({ hts_code }) => {
    const line = lookupExact(hts_code);
    if (!line) {
      return `NOT FOUND: "${hts_code}" does not exist in this HTSUS revision. Do not use it. If you expected it to exist, the statistical breakout may have changed between editions — search for the good again rather than substituting a nearby code.`;
    }

    const ancestors = getAncestors(hts_code);
    const sections: string[] = [];

    if (ancestors.length > 0) {
      sections.push(
        `Ancestry:\n${ancestors.map((a) => `  ${a.htsNo || "(no number)"}  ${a.description}`).join("\n")}`,
      );
    }
    sections.push(formatLine(line));

    const footnotesWithCh99 = [...ancestors, line].some((l) =>
      l.footnotes.some((f) => /\b99\d{2}\./.test(f)),
    );
    if (footnotesWithCh99) {
      sections.push(
        "This line or an ancestor references Chapter 99 — call chapter99_lookup for the additional duties.",
      );
    }

    return sections.join("\n\n");
  },
});

export const htsSubtreeTool = betaZodTool({
  name: "hts_subtree",
  description:
    "Return everything at or beneath an HTS number, indented as the printed schedule reads. Use this for GRI 6: you cannot choose between sibling subheadings or statistical breakouts without seeing them side by side.",
  inputSchema: z.object({
    hts_code: z
      .string()
      .describe("Heading or subheading, e.g. '8507' or '8507.60'."),
    max_rows: z
      .number()
      .int()
      .describe("Cap on rows returned, 1-400. Use 400 for a whole heading."),
  }),
  run: ({ hts_code, max_rows }) => {
    const rows = getSubtree(hts_code, Math.min(Math.max(max_rows, 1), 400));
    if (rows.length === 0) {
      return `NOT FOUND: nothing at or beneath "${hts_code}" in this revision.`;
    }
    return rows.map(formatTreeRow).join("\n");
  },
});

export const htsNotesTool = betaZodTool({
  name: "hts_notes",
  description:
    "Retrieve Section or Chapter notes. GRI 1 makes these binding, not background — read the notes for every chapter you are seriously considering, including the one you intend to rule out.",
  inputSchema: z.object({
    kind: z.enum(["section", "chapter"]),
    reference: z
      .string()
      .describe("Chapter as two digits ('85'), section as a Roman numeral ('XVI')."),
  }),
  run: ({ kind, reference }) => {
    const ref = kind === "chapter" ? reference.padStart(2, "0") : reference.toUpperCase();
    const notes = getNotes(kind, ref);

    if (notes.length === 0) {
      return `No ${kind} notes are stored for "${reference}" in this snapshot. Treat this as "not retrieved", NOT as "this ${kind} has no notes" — the sync may not have captured them. Do not conclude that no relevant note exists; say in your analysis that the notes could not be consulted.`;
    }

    return notes
      .map((note) => `${note.title}\n\n${truncate(note.body, 12_000)}`)
      .join("\n\n---\n\n");
  },
});

export const htsGriTool = betaZodTool({
  name: "hts_gri",
  description:
    "The General Notes, the General Rules of Interpretation, and the Additional U.S. Rules of Interpretation, verbatim from this revision. Consult them rather than paraphrasing from memory when a rule is doing real work in your analysis.",
  inputSchema: z.object({}),
  run: () => {
    const rules = getGeneralRules();
    if (rules.length === 0) {
      return "The General Notes were not captured in this snapshot. Apply the GRIs from your own knowledge, and note in your analysis that the rule text could not be verified against this revision.";
    }
    return rules
      .map((rule) => `${rule.title}\n\n${truncate(rule.body, 20_000)}`)
      .join("\n\n---\n\n");
  },
});

export const chapter99LookupTool = betaZodTool({
  name: "chapter99_lookup",
  description:
    "Find Chapter 99 additional duties (Section 301, Section 232 and similar) that reference a base HTS number. Run this for any code you are going to recommend — the base rate alone frequently understates actual duty exposure by a wide margin.",
  inputSchema: z.object({
    hts_code: z.string().describe("The base HTS number being classified."),
  }),
  run: ({ hts_code }) => {
    if (!lookupExact(hts_code)) {
      return `NOT FOUND: "${hts_code}" does not exist in this revision, so no Chapter 99 lookup was performed.`;
    }

    const entries = getChapter99Candidates(hts_code);
    if (entries.length === 0) {
      return `No Chapter 99 provisions reference ${hts_code} via footnotes in this snapshot. Trade actions change faster than HTSUS revisions are published, so report this as "none found in this revision" rather than as a guarantee that none apply.`;
    }

    return entries
      .map(
        (entry) =>
          `${entry.htsNo}  [${entry.program}]\n  ${entry.description}\n  Additional duty: ${entry.additionalDuty || "see subheading text"}`,
      )
      .join("\n\n");
  },
});

export const scheduleBLookupTool = betaZodTool({
  name: "schedule_b_lookup",
  description:
    "Map a 10-digit HTSUS number to its Schedule B export code via the Census concordance. Import and export codes are not interchangeable, and the mapping is not always one to one.",
  inputSchema: z.object({
    hts_code: z.string().describe("A 10-digit HTSUS number."),
  }),
  run: ({ hts_code }) => {
    const entries = getScheduleB(hts_code);
    if (entries.length === 0) {
      return `No Schedule B mapping for ${hts_code} in this snapshot. This may mean the concordance was unavailable at sync time rather than that no mapping exists — do not assert that the good has no export code.`;
    }
    return entries
      .map((entry) => `${entry.scheduleB}  ${entry.description}`)
      .join("\n");
  },
});

/** Every local tool, in the order the agent should generally reach for them. */
export const classificationTools = [
  htsSearchTool,
  htsLookupTool,
  htsSubtreeTool,
  htsNotesTool,
  htsGriTool,
  chapter99LookupTool,
  scheduleBLookupTool,
];

export const LOCAL_TOOL_NAMES = classificationTools.map((tool) => tool.name);
