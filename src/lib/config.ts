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
   * smaller models.
   */
  model: "claude-opus-5" as const,

  /**
   * Reasoning depth. `max` is the default because tariff classification is a
   * correctness-over-cost task, but it is genuinely expensive — see the
   * "Tuning cost vs. depth" section of the README before lowering it.
   */
  get effort(): Effort {
    return parseEffort(optional("CLASSIFIER_EFFORT", "max"));
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
