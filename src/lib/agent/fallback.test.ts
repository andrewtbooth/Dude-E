/**
 * The grammar-rejection fallback.
 *
 * `output_config.format` compiles the output schema *and* every tool schema in
 * the request into one decoding grammar, and the API rejects the request when
 * that compiles too large. Anthropic publishes no size limit, so there is no
 * number to design against — a schema that fits today stops fitting when
 * someone adds a tool. Rather than tune toward an invisible threshold, the run
 * detects the rejection and re-asks for the same shape in the prompt.
 *
 * These tests cover the two pieces that decide whether that works: recognising
 * the rejection, and reading the answer back when nothing enforced its shape.
 */

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { extractJsonObject, isGrammarTooLarge } from "./classify";

function apiError(status: number, message: string) {
  return new Anthropic.APIError(
    status,
    { type: "error", error: { type: "invalid_request_error", message } },
    message,
    new Headers(),
  );
}

describe("isGrammarTooLarge", () => {
  it("recognises the rejection the API actually sends", () => {
    // Verbatim from request_id req_011Cdh2S5ehEZPMDZPsHzy8Z.
    const error = apiError(
      400,
      "The compiled grammar is too large, which would cause performance " +
        "issues. Simplify your tool schemas or reduce the number of strict tools.",
    );
    expect(isGrammarTooLarge(error)).toBe(true);
  });

  it("does not downgrade on unrelated 400s", () => {
    // Retrying these without the schema would waste a full run and hide the
    // real fault behind a confusing warning.
    expect(isGrammarTooLarge(apiError(400, "max_tokens: must be >= 1"))).toBe(
      false,
    );
    expect(
      isGrammarTooLarge(apiError(400, "messages.0: expected user role")),
    ).toBe(false);
  });

  it("does not downgrade on auth, rate-limit or server errors", () => {
    expect(isGrammarTooLarge(apiError(401, "invalid x-api-key"))).toBe(false);
    expect(isGrammarTooLarge(apiError(429, "rate_limit_error"))).toBe(false);
    expect(isGrammarTooLarge(apiError(500, "internal server error"))).toBe(
      false,
    );
  });

  it("ignores non-API errors", () => {
    expect(isGrammarTooLarge(new Error("compiled grammar is too large"))).toBe(
      false,
    );
    expect(isGrammarTooLarge(undefined)).toBe(false);
    expect(isGrammarTooLarge("compiled grammar is too large")).toBe(false);
  });
});

describe("extractJsonObject", () => {
  const payload = '{"status":"complete","candidates":[]}';

  it("returns a bare object untouched — the structured-output case", () => {
    expect(extractJsonObject(payload)).toBe(payload);
    expect(extractJsonObject(`\n  ${payload}\n`)).toBe(payload);
  });

  it("unwraps a fenced block", () => {
    expect(extractJsonObject("```json\n" + payload + "\n```")).toBe(payload);
    expect(extractJsonObject("```\n" + payload + "\n```")).toBe(payload);
  });

  it("recovers the object when the model wraps it in prose", () => {
    const wrapped = `Here is the determination:\n\n${payload}\n\nLet me know.`;
    expect(JSON.parse(extractJsonObject(wrapped))).toEqual({
      status: "complete",
      candidates: [],
    });
  });

  it("keeps nested braces intact", () => {
    const nested = '{"a":{"b":{"c":1}},"d":[{"e":2}]}';
    expect(JSON.parse(extractJsonObject(`prose ${nested} more prose`))).toEqual({
      a: { b: { c: 1 } },
      d: [{ e: 2 }],
    });
  });

  it("passes through text with no object so the parse error is the real one", () => {
    // Better to fail on "not valid JSON" than to invent a fragment that
    // parses into something the schema then rejects for the wrong reason.
    expect(extractJsonObject("I could not complete this analysis.")).toBe(
      "I could not complete this analysis.",
    );
  });
});
