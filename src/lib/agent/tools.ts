import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import {
  getAncestors,
  getChapter99Candidates,
  getChapter99Coverage,
  getGeneralRules,
  getNotes,
  getScheduleB,
  getSubtree,
  lookupExact,
  searchHts,
  searchScheduleB,
} from "../hts/store";
import { toDigits } from "../hts/parse";
import { sectionForChapter } from "../hts/sections";
import type { HtsLine, ScheduleBLine } from "../hts/types";

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

/**
 * Notes are handed to the model nearly whole.
 *
 * The old 12,000-character cap cut the chapters where the notes matter most —
 * Chapter 84 runs 31,749 characters, Chapter 72 29,968, Chapter 85 29,428 — so
 * the model saw under half of the binding material for machinery, steel and
 * electricals, and the truncation notice told it to "request a narrower
 * reference" that this tool does not accept. This clears every chapter in the
 * live tariff with room to spare.
 */
const MAX_NOTE_CHARS = 60_000;

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n\n[Truncated at ${max} characters. The rest of these notes was not shown — do not treat what is above as the complete notes for this reference.]`;
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
    const cap = Math.min(Math.max(max_rows, 1), 400);
    const rows = getSubtree(hts_code, cap);
    if (rows.length === 0) {
      return `NOT FOUND: nothing at or beneath "${hts_code}" in this revision.`;
    }

    const tree = rows.map(formatTreeRow).join("\n");

    // Say so when the cap bites. Silent truncation here is the worst kind: the
    // whole point of this tool is comparing siblings under GRI 6, and a caller
    // who cannot see the last breakouts will conclude they do not exist and
    // settle for a residual instead.
    const digits = toDigits(hts_code);
    const matched = rows.filter((row) => row.digits.startsWith(digits)).length;
    if (matched >= cap) {
      return (
        `${tree}\n\n[Truncated at ${cap} matching lines — there may be further ` +
        `breakouts under ${hts_code} that are not shown. Request a narrower ` +
        `subheading, or raise max_rows, before concluding a breakout is absent.]`
      );
    }
    return tree;
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
    const section = kind === "chapter" ? sectionForChapter(ref) : null;
    const notes = getNotes(kind, ref);

    if (notes.length === 0) {
      return `No ${kind} notes are stored for "${reference}" in this snapshot. Treat this as "not retrieved", NOT as "this ${kind} has no notes" — the sync may not have captured them. Do not conclude that no relevant note exists; say in your analysis that the notes could not be consulted.`;
    }

    const body = notes
      .map((note) => `${note.title}\n\n${truncate(note.body, MAX_NOTE_CHARS)}`)
      .join("\n\n---\n\n");

    // Section notes are published only with the section's first chapter, so a
    // chapter's own document usually does not carry them — and they are binding
    // under GRI 1. Naming the section here stops the model reading the chapter
    // notes and taking that for the whole of the binding material.
    if (section) {
      return (
        `${body}\n\n---\n\nChapter ${ref} sits in Section ${section}. Its notes ` +
        `are separate and equally binding — call hts_notes(kind:"section", ` +
        `reference:"${section}") before relying on this.`
      );
    }
    return body;
  },
});

export const htsGriTool = betaZodTool({
  name: "hts_gri",
  description:
    "The General Rules of Interpretation, the Additional U.S. Rules of Interpretation, and General Notes 1-2, verbatim from this revision. Consult them rather than paraphrasing from memory when a rule is doing real work. Note the limit: General Note 3 onward — the rate-column definitions and every free trade agreement's rules of origin — is NOT included, so do not assess preference eligibility or read the Special column's programme codes as analysed.",
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
    const coverage = getChapter99Coverage(hts_code);

    const sections: string[] = [];

    if (entries.length > 0) {
      sections.push(
        `Provisions referenced by a footnote on this line or an ancestor:\n\n` +
          entries
            .map(
              (entry) =>
                `${entry.htsNo}  [${entry.program}]\n  ${entry.description}\n  Additional duty: ${entry.additionalDuty || "see subheading text"}`,
            )
            .join("\n\n"),
      );
    }

    if (coverage.length > 0) {
      sections.push(
        `This subheading is ENUMERATED in ${coverage.length} Chapter 99 U.S. ` +
          `note${coverage.length === 1 ? "" : "s"}. These notes define coverage from ` +
          `the Chapter 99 side, which is how most Section 301 and 232 exposure is ` +
          `expressed — a good can be covered with no footnote on its line at all.\n\n` +
          coverage
            .map(
              (row) =>
                `U.S. note ${row.noteRef}` +
                (row.headings.length > 0
                  ? ` — heading${row.headings.length === 1 ? "" : "s"} ${row.headings.join(", ")}`
                  : "") +
                `\n  ${row.excerpt}`,
            )
            .join("\n\n") +
          `\n\nRead these before reporting duty exposure. They carry conditions ` +
          `this index does not evaluate — country of origin, effective and expiry ` +
          `dates, granted exclusions, and carve-outs — and some enumerate goods ` +
          `that are EXEMPT rather than covered. Report what the note says, ` +
          `conditionally on origin, rather than asserting a rate.`,
      );
    }

    if (sections.length === 0) {
      return `No Chapter 99 provision references ${hts_code} by footnote, and no Chapter 99 U.S. note enumerates this subheading, in this snapshot. Both checks are incomplete by nature: footnotes are published on only some covered lines, and trade actions change faster than HTSUS revisions. Report this as "none found in this revision", never as a guarantee that none apply.`;
    }

    return sections.join("\n\n---\n\n");
  },
});

function formatScheduleBLine(line: ScheduleBLine): string {
  const facts = [
    line.units.length > 0 ? `units: ${line.units.join(", ")}` : null,
    line.isAgricultural ? "agricultural commodity" : null,
  ].filter(Boolean);
  return (
    `${line.htsNo}  ${line.description}` +
    (facts.length > 0 ? `\n  (${facts.join("; ")})` : "")
  );
}

export const scheduleBLookupTool = betaZodTool({
  name: "schedule_b_lookup",
  description:
    "List the Schedule B export codes available under the same 6-digit HS subheading as an HTSUS number. Returns candidates, not an answer: the import and export schedules share the first 6 digits but break out differently below them, so you must read the descriptions and choose, exactly as you would for a statistical suffix under GRI 6.",
  inputSchema: z.object({
    hts_code: z
      .string()
      .describe("An HTSUS number. 10 digits is usual; 6 or 8 also work."),
  }),
  run: ({ hts_code }) => {
    const { hs6, candidates, hasIdenticalCode } = getScheduleB(hts_code);

    if (hs6.length < 6) {
      return `${hts_code} does not contain a 6-digit HS subheading, so there is nothing to match against the export schedule.`;
    }

    if (candidates.length === 0) {
      return (
        `No Schedule B codes exist under HS subheading ${hs6}. This happens: the export ` +
        `schedule does not use every subheading the tariff does (Chapter 98 provisions ` +
        `especially). Use schedule_b_search to find the export code by description ` +
        `instead, and say in your justification that it was not reachable from the HTS number.`
      );
    }

    const header =
      `Schedule B codes under HS subheading ${hs6} (${candidates.length} candidate` +
      `${candidates.length === 1 ? "" : "s"}):`;

    const body = candidates.map(formatScheduleBLine).join("\n");

    // Both notes can apply at once — a subheading with a single candidate whose
    // digits also match is exactly the case most likely to be rubber-stamped —
    // so they are additive rather than a chain of alternatives.
    const guidance: string[] = [];
    if (candidates.length === 1) {
      guidance.push(
        "Only one export code sits under this subheading. Confirm its description actually covers the good before adopting it — a single candidate is not automatically the right one.",
      );
    } else {
      guidance.push("Choose on the description, not on the number.");
    }
    guidance.push(
      hasIdenticalCode
        ? "One candidate shares all ten digits with the HTS number. That is a coincidence of the two schedules' numbering, not evidence — if you adopt it, say why its description fits."
        : "No candidate shares all ten digits with the HTS number, which is normal and not a problem.",
    );

    return `${header}\n${body}\n\n${guidance.join(" ")}`;
  },
});

export const scheduleBSearchTool = betaZodTool({
  name: "schedule_b_search",
  description:
    "Full-text search the Schedule B export schedule by description. Use when schedule_b_lookup returns no candidates for the HS subheading, or to confirm that a chosen export code is the best fit among similarly worded ones.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Words describing the good. Census descriptions are terse and abbreviated, so prefer plain nouns over long phrases.",
      ),
    limit: z.number().int().min(1).max(40).default(15),
  }),
  run: ({ query, limit }) => {
    const hits = searchScheduleB(query, limit);
    if (hits.length === 0) {
      return `No Schedule B codes match "${query}". Census descriptions are heavily abbreviated ("FLASK AND OTHER VESSELS, COMPLETE WITH CASES"), so try a shorter or more literal term.`;
    }
    return hits.map(formatScheduleBLine).join("\n");
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
  scheduleBSearchTool,
];

export const LOCAL_TOOL_NAMES = classificationTools.map((tool) => tool.name);
