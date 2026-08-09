import { afterEach, describe, expect, it } from "vitest";
import { CLASSIFIER_MODELS, config } from "./config";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

/**
 * The model selection exists so a trial can be run cheaply. What makes it worth
 * testing is that the tiers do not accept the same request: an effort level is
 * a 400 on Haiku and adaptive thinking is a 400 there too, while `budget_tokens`
 * is a 400 on Opus 5. Every assertion below is about catching that mismatch at
 * config load rather than three minutes and several dollars into a run.
 */
describe("classifier model selection", () => {
  it("defaults to the model the prompt was tuned against", () => {
    delete process.env.CLASSIFIER_MODEL;
    expect(config.model).toBe("claude-opus-5");
  });

  it("refuses a model it cannot build a request for", () => {
    // Including real Anthropic models that are simply not in the table: the
    // failure mode is a request shape nobody chose, not an unknown string.
    for (const bad of ["claude-opus-4-8", "gpt-4", "haiku", ""]) {
      process.env.CLASSIFIER_MODEL = bad;
      if (bad === "") {
        expect(config.model).toBe("claude-opus-5"); // empty reads as unset
      } else {
        expect(() => config.model).toThrow(/CLASSIFIER_MODEL must be one of/);
      }
    }
  });

  it("reports each model's capabilities as the API defines them", () => {
    expect(CLASSIFIER_MODELS["claude-opus-5"].effort).toBe(true);
    expect(CLASSIFIER_MODELS["claude-sonnet-5"].effort).toBe(true);
    // The row this whole mechanism exists for.
    expect(CLASSIFIER_MODELS["claude-haiku-4-5"].effort).toBe(false);
    expect(CLASSIFIER_MODELS["claude-haiku-4-5"].thinking).toBe("budget");
  });
});

describe("effort", () => {
  it("defaults to max on a model that accepts an effort level", () => {
    process.env.CLASSIFIER_MODEL = "claude-opus-5";
    delete process.env.CLASSIFIER_EFFORT;
    expect(config.effort).toBe("max");
    expect(config.effortLabel).toBe("max");
  });

  it("is null on a model with no effort parameter", () => {
    process.env.CLASSIFIER_MODEL = "claude-haiku-4-5";
    delete process.env.CLASSIFIER_EFFORT;
    expect(config.effort).toBeNull();
  });

  it("refuses an effort level on a model that rejects the parameter", () => {
    // The failure this prevents is silent: without it, someone sets
    // CLASSIFIER_EFFORT=low to save money, the parameter is dropped, and
    // nothing says so until the invoice.
    process.env.CLASSIFIER_MODEL = "claude-haiku-4-5";
    process.env.CLASSIFIER_EFFORT = "low";
    expect(() => config.effort).toThrow(
      /claude-haiku-4-5 does not accept output_config.effort/,
    );
  });

  it("still rejects a nonsense effort level on a model that takes one", () => {
    process.env.CLASSIFIER_MODEL = "claude-opus-5";
    process.env.CLASSIFIER_EFFORT = "maximum";
    expect(() => config.effort).toThrow(/CLASSIFIER_EFFORT must be one of/);
  });
});

describe("effortLabel", () => {
  /**
   * Rendered as "<model>, <label> effort" in the PDF provenance block and the
   * result header. A determination is re-rendered from frozen inputs on every
   * re-issue and the stored hash is compared against the result, so this value
   * has to stay a short stable token — a sentence here would read as tampering
   * on any already-issued document.
   */
  it("names the level when there is one", () => {
    process.env.CLASSIFIER_MODEL = "claude-sonnet-5";
    process.env.CLASSIFIER_EFFORT = "low";
    expect(config.effortLabel).toBe("low");
  });

  it("is a short marker, not prose, when there is no level", () => {
    process.env.CLASSIFIER_MODEL = "claude-haiku-4-5";
    delete process.env.CLASSIFIER_EFFORT;
    expect(config.effortLabel).toBe("n/a");
    expect(config.effortLabel.length).toBeLessThan(12);
  });
});
