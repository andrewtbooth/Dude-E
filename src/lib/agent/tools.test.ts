import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupFixtureIndex, teardownFixtureIndex } from "../../test/htsus-fixture";
import {
  chapter99LookupTool,
  htsGriTool,
  htsLookupTool,
  htsNotesTool,
  htsSearchTool,
  htsSubtreeTool,
  scheduleBLookupTool,
} from "./tools";

beforeAll(() => setupFixtureIndex());
afterAll(() => teardownFixtureIndex());

/** The runner passes plain objects through; call the run fn directly. */
async function run<T>(
  tool: { run: (args: T) => unknown },
  args: T,
): Promise<string> {
  return String(await tool.run(args));
}

describe("hts_search", () => {
  it("returns matching lines with their full path", async () => {
    const output = await run(htsSearchTool, {
      query: "lithium ion battery",
      chapter: null,
      reportable_only: false,
      limit: 25,
    });
    expect(output).toContain("8507.60");
    expect(output).toContain("Electric storage batteries");
  });

  it("says so plainly when nothing matches, with a next step", async () => {
    const output = await run(htsSearchTool, {
      query: "zzzzz nonexistent commodity",
      chapter: null,
      reportable_only: false,
      limit: 25,
    });
    expect(output).toMatch(/No matches/);
    expect(output).toMatch(/Try different terms/);
  });

  it("honours the reportable-only filter", async () => {
    const output = await run(htsSearchTool, {
      query: "vacuum flask",
      chapter: null,
      reportable_only: true,
      limit: 25,
    });
    for (const line of output.split("\n")) {
      expect(line).toContain("(10-digit)");
    }
  });
});

describe("hts_lookup", () => {
  it("returns the line, its ancestry, and inherited-rate provenance", async () => {
    const output = await run(htsLookupTool, { hts_code: "8507.60.00.20" });

    expect(output).toContain("Ancestry:");
    expect(output).toContain("8507.60.00");
    expect(output).toContain("General: 3.4%");
    expect(output).toContain("rates published on 8507.60.00, inherited");
    expect(output).toContain("reportable (10-digit, declarable): yes");
  });

  it("flags a nonexistent code loudly and forbids its use", async () => {
    // This is the anti-fabrication guardrail. The wording matters: the model
    // must not read a miss as an invitation to substitute a nearby code.
    const output = await run(htsLookupTool, { hts_code: "8507.60.00.99" });

    expect(output).toMatch(/^NOT FOUND/);
    expect(output).toContain("Do not use it");
    expect(output).not.toContain("General:");
  });

  it("points at Chapter 99 when an ancestor footnote references it", async () => {
    const output = await run(htsLookupTool, { hts_code: "8507.60.00.20" });
    expect(output).toContain("chapter99_lookup");
  });

  it("accepts an undotted code", async () => {
    const output = await run(htsLookupTool, { hts_code: "9617001000" });
    expect(output).toContain("9617.00.10.00");
  });
});

describe("hts_subtree", () => {
  it("renders the breakouts indented, as the schedule reads", async () => {
    const output = await run(htsSubtreeTool, {
      hts_code: "8507.60",
      max_rows: 400,
    });
    const lines = output.split("\n");

    expect(lines[0]).toContain("8507.60");
    // Statistical breakouts are indented beneath the rate line.
    expect(output).toContain("      8507.60.00.10");
    expect(output).toContain("      8507.60.00.20");
  });

  it("reports a miss rather than returning an empty string", async () => {
    const output = await run(htsSubtreeTool, {
      hts_code: "1234.56",
      max_rows: 100,
    });
    expect(output).toMatch(/^NOT FOUND/);
  });
});

describe("hts_notes", () => {
  it("returns chapter notes", async () => {
    const output = await run(htsNotesTool, { kind: "chapter", reference: "96" });
    expect(output).toContain("Chapter 96 Notes");
    expect(output).toContain("parts of general use");
  });

  it("zero-pads a single-digit chapter reference", async () => {
    const output = await run(htsNotesTool, { kind: "chapter", reference: "96" });
    expect(output).not.toMatch(/^No chapter notes/);
  });

  it("distinguishes 'not retrieved' from 'no notes exist'", async () => {
    // Collapsing these two is how a model concludes no relevant note exists
    // and skips the GRI 1 analysis that the note would have decided.
    const output = await run(htsNotesTool, { kind: "section", reference: "XVI" });
    expect(output).toContain('Treat this as "not retrieved"');
    expect(output).toContain("Do not conclude that no relevant note exists");
  });
});

describe("hts_gri", () => {
  it("returns the rule text verbatim", async () => {
    const output = await run(htsGriTool, {});
    expect(output).toContain("terms of the headings");
  });
});

describe("chapter99_lookup", () => {
  it("finds a Section 301 provision referenced by an ancestor footnote", async () => {
    const output = await run(chapter99LookupTool, {
      hts_code: "8507.60.00.20",
    });
    expect(output).toContain("9903.88.03");
    expect(output).toContain("Section 301 (China)");
    expect(output).toContain("25%");
  });

  it("refuses to look up a code that does not exist", async () => {
    const output = await run(chapter99LookupTool, { hts_code: "8507.60.00.99" });
    expect(output).toMatch(/^NOT FOUND/);
  });

  it("hedges a null result rather than guaranteeing no duties apply", async () => {
    const output = await run(chapter99LookupTool, {
      hts_code: "9617.00.10.00",
    });
    expect(output).toContain("No Chapter 99 provisions");
    expect(output).toContain("rather than as a guarantee");
  });
});

describe("schedule_b_lookup", () => {
  it("maps a 10-digit HTSUS number to its export code", async () => {
    const output = await run(scheduleBLookupTool, {
      hts_code: "8507.60.00.20",
    });
    expect(output).toContain("8507.60.0000");
  });

  it("does not assert the good has no export code when the map is empty", async () => {
    const output = await run(scheduleBLookupTool, {
      hts_code: "7323.93.00.80",
    });
    expect(output).toContain("do not assert that the good has no export code");
  });
});
