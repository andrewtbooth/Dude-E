/**
 * Centralised environment access.
 *
 * Every tunable the app has lives here as a named constant rather than being
 * read inline at call sites, so there is exactly one place to look when asking
 * "what is this deployment actually configured to do?".
 */

import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

/**
 * The models this app knows how to build a request for, and what each accepts.
 *
 * These are not preferences — they are request-shape facts, and they differ
 * across the tiers in ways that make a bare model-string swap a 400:
 *
 *   - Opus 5 / Sonnet 5 take `thinking: {type: "adaptive"}` and
 *     `output_config.effort`, and reject `budget_tokens`.
 *   - Haiku 4.5 is the inverse: it rejects adaptive thinking *and* rejects
 *     `output_config.effort`, and controls depth with `budget_tokens`.
 *
 * Sending the wrong pair fails several seconds into a run, which during a
 * trial reads as "the app is broken" rather than "the model was changed".
 * Encoding it here means `classify()` builds whatever the configured model
 * actually accepts, and a bad combination is caught at config load instead.
 */
export const CLASSIFIER_MODELS = {
  "claude-opus-5": {
    thinking: "adaptive",
    effort: true,
    contextTokens: 1_000_000,
  },
  "claude-sonnet-5": {
    thinking: "adaptive",
    effort: true,
    contextTokens: 1_000_000,
  },
  "claude-haiku-4-5": {
    thinking: "budget",
    effort: false,
    contextTokens: 200_000,
  },
} as const;

export type ClassifierModel = keyof typeof CLASSIFIER_MODELS;
export type ModelCapabilities = (typeof CLASSIFIER_MODELS)[ClassifierModel];

function parseModel(raw: string): ClassifierModel {
  const value = raw.trim();
  if (value in CLASSIFIER_MODELS) return value as ClassifierModel;
  throw new Error(
    `CLASSIFIER_MODEL must be one of ${Object.keys(CLASSIFIER_MODELS).join(
      ", ",
    )} (got "${raw}"). Adding a model means adding its row to ` +
      `CLASSIFIER_MODELS — the request shape is derived from it.`,
  );
}

/**
 * Thinking budget for models that take one instead of an effort level.
 *
 * Must be below MAX_OUTPUT_TOKENS and at least 1024, both enforced by the API.
 * Sized to leave the great majority of the output budget for a full GRI 1-6
 * walk across five candidates, which is the part that has to fit.
 */
export const THINKING_BUDGET_TOKENS = 8_000;

/** Reasoning effort levels accepted by the Messages API. */
export const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

function parseEffort(raw: string): Effort {
  const value = raw.trim().toLowerCase();
  if ((EFFORT_LEVELS as readonly string[]).includes(value)) {
    return value as Effort;
  }
  throw new Error(
    `CLASSIFIER_EFFORT must be one of ${EFFORT_LEVELS.join(", ")} (got "${raw}").`,
  );
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}").`);
  }
  return value;
}

export const config = {
  /**
   * Analyses allowed per client per window. A budget guard rather than access
   * control — see src/lib/rateLimit.ts. Sized so an analyst working steadily
   * never notices it and a script hitting the endpoint does, immediately.
   */
  get analyzeRateLimit(): number {
    return optionalInt("ANALYZE_RATE_LIMIT", 10);
  },
  get analyzeRateWindowMs(): number {
    return optionalInt("ANALYZE_RATE_WINDOW_MINUTES", 15) * 60_000;
  },

  /**
   * The classification model. Opus 5 is the only model this prompt has been
   * tuned against; the GRI discipline it enforces degrades noticeably on
   * smaller models, so a cheaper setting is a trial affordance rather than a
   * deployment choice. Whatever is set here is stamped onto every analysis and
   * every determination, so an artifact produced by a cheap run says so.
   */
  get model(): ClassifierModel {
    return parseModel(optional("CLASSIFIER_MODEL", "claude-opus-5"));
  },

  get modelCapabilities(): ModelCapabilities {
    return CLASSIFIER_MODELS[this.model];
  },

  /**
   * Reasoning depth. `max` is the default because tariff classification is a
   * correctness-over-cost task, but it is genuinely expensive — see the
   * "Tuning cost vs. depth" section of the README before lowering it.
   *
   * Null on models that have no effort parameter; those take a thinking budget
   * instead. Setting CLASSIFIER_EFFORT on such a model is an error rather than
   * a silent no-op, because the failure it prevents — believing you dialled
   * cost down when nothing changed — is invisible until the bill arrives.
   */
  get effort(): Effort | null {
    const raw = process.env.CLASSIFIER_EFFORT;
    const isSet = Boolean(raw && raw.trim() !== "");

    if (!this.modelCapabilities.effort) {
      if (isSet) {
        throw new Error(
          `${this.model} does not accept output_config.effort; the API rejects ` +
            `it. Depth on this model is set by THINKING_BUDGET_TOKENS ` +
            `(currently ${THINKING_BUDGET_TOKENS}). Unset CLASSIFIER_EFFORT, ` +
            `or use a model that takes an effort level.`,
        );
      }
      return null;
    }
    return parseEffort(isSet ? (raw as string) : "max");
  },

  /**
   * What to stamp in the `effort` slot of an analysis or determination.
   *
   * Rendered as "<model>, <this> effort" in the PDF and the result header, so
   * it has to read correctly there for a model that has no effort level. Kept
   * as a short token rather than a sentence: existing rows are re-rendered on
   * every PDF re-issue, and the hash check treats a formatting change as
   * tampering.
   */
  get effortLabel(): string {
    return this.effort ?? "n/a";
  },

  /**
   * Path to a recorded run to serve instead of calling the API, or null.
   *
   * A development affordance for exercising everything downstream of the model
   * — the question loop, selection, determination recording, the PDF, history —
   * without paying for an agent run each time. Ignored outside development, and
   * every run it produces is stamped `replay:` so an artifact built from one is
   * self-identifying. See src/lib/agent/replay.ts.
   */
  get replayCassette(): string | null {
    const value = process.env.CLASSIFIER_REPLAY;
    if (!value || value.trim() === "") return null;
    if (process.env.NODE_ENV === "production") return null;
    return value.trim();
  },

  /** Per-event pacing for a replay, so the SSE path is exercised too. */
  get replayStepDelayMs(): number {
    return optionalInt("CLASSIFIER_REPLAY_DELAY_MS", 120);
  },

  get anthropicApiKey(): string {
    return required("ANTHROPIC_API_KEY");
  },

  get sessionSecret(): string {
    return required("SESSION_SECRET");
  },

  get sessionTtlHours(): number {
    const parsed = Number(optional("SESSION_TTL_HOURS", "12"));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
  },

  get htsusDataDir(): string {
    return path.resolve(optional("HTSUS_DATA_DIR", "./data/htsus"));
  },

  get usitcBaseUrl(): string {
    return optional("USITC_BASE_URL", "https://hts.usitc.gov/reststop").replace(
      /\/+$/,
      "",
    );
  },
} as const;

/**
 * Output token ceiling for a classification run. Generous because a full
 * GRI 1-6 walk across five candidates with citations is long, and truncating
 * mid-analysis wastes the entire (expensive) run.
 */
export const MAX_OUTPUT_TOKENS = 32_000;

/** Hard cap on agent tool-loop iterations, to bound a runaway analysis. */
export const MAX_TOOL_ITERATIONS = 40;

/** Hard cap on `pause_turn` resumes before we give up on a run. */
export const MAX_PAUSE_RESUMES = 5;

/** App version stamped onto every exported determination. */
export const APP_VERSION = "0.1.0";
