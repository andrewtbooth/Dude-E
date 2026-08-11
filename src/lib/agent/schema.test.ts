import { describe, expect, it } from "vitest";
import { resultSchemaFor } from "./schema";

/**
 * What happens when the model's JSON is not quite the shape we asked for.
 *
 * This matters more here than the schema being well-formed. The output schema
 * does not fit the API's grammar limit and never has, so on a live run the
 * shape is asked for in the prompt and validated on return — and validation is
 * all-or-nothing. A single missing key throws, and the analyst loses a run that
 * took minutes at max effort along with what it cost.
 */

const minimalResult = {
  status: "complete",
  htsus_revision: "2026 HTS Revision 15",
  summary: "A stainless steel vacuum-insulated bottle.",
  clarifying_questions: [],
  candidates: [],
  recommended_hts_code: null,
  assumptions: [],
  info_that_would_raise_confidence: [],
  chapter_98_provisions: [],
};

describe("the classification result contract", () => {
  it("accepts a well-formed answer", () => {
    const parsed = resultSchemaFor("DESCRIPTION").safeParse(minimalResult);
    expect(parsed.success).toBe(true);
  });

  it("survives an answer that omits chapter_98_provisions", () => {
    // The newest field, and the one field whose absence has an obviously
    // correct reading: no provision was named. Failing the whole run over it
    // would throw away the analysis to punish a missing empty array.
    const { chapter_98_provisions, ...withoutIt } = minimalResult;
    void chapter_98_provisions;

    const parsed = resultSchemaFor("DESCRIPTION").safeParse(withoutIt);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.chapter_98_provisions).toEqual([]);
  });

  it("still refuses an answer missing something load-bearing", () => {
    // The mirror: defaulting one field must not have made the contract
    // permissive generally. A result with no status is not a result.
    const { status, ...withoutStatus } = minimalResult;
    void status;

    expect(resultSchemaFor("DESCRIPTION").safeParse(withoutStatus).success).toBe(
      false,
    );
  });

  it("refuses a Chapter 98 entry that does not say when it applies", () => {
    // `applies_when` is the whole point of the field. A provision named with
    // no conditions reads as though it simply applies, which is the opposite
    // of what it means.
    const parsed = resultSchemaFor("DESCRIPTION").safeParse({
      ...minimalResult,
      chapter_98_provisions: [
        { hts_code: "9813.00.20", provision: "Temporary importation under bond" },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
