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
};

describe("the classification result contract", () => {
  it("accepts a well-formed answer", () => {
    const parsed = resultSchemaFor("DESCRIPTION").safeParse(minimalResult);
    expect(parsed.success).toBe(true);
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
});
