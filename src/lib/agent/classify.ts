import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaMessage,
  MessageCreateParams as BetaMessageParams,
} from "@anthropic-ai/sdk/resources/beta";
import {
  MAX_OUTPUT_TOKENS,
  MAX_PAUSE_RESUMES,
  MAX_TOOL_ITERATIONS,
  THINKING_BUDGET_TOKENS,
  config,
} from "../config";
import {
  getActiveRevision,
  lookupExact,
  lookupScheduleB,
} from "../hts/store";
import * as z from "zod/v4";
import { buildOutputContract, buildSystemPrompt, buildUserTurn } from "./prompt";
import { replayCassette } from "./replay";
import {
  type AnalysisMode,
  type Candidate,
  type ClassificationResult,
  type Refinement,
  resultSchemaFor,
} from "./schema";
import { classificationTools } from "./tools";

// ---------------------------------------------------------------------------
// Progress events (consumed by the SSE route)
// ---------------------------------------------------------------------------

export type ProgressEvent =
  | { type: "status"; message: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; summary: string }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "warning"; message: string }
  | { type: "done"; run: ClassificationRun }
  | { type: "error"; message: string };

export interface CodeCorrection {
  htsCode: string;
  field: string;
  modelValue: string;
  indexValue: string;
}

export interface ClassificationRun {
  result: ClassificationResult;
  verification: {
    verifiedCodes: string[];
    /** Codes the model returned that do not exist in this revision. */
    rejectedCodes: { code: string; reason: string }[];
    /** Data fields where the model's transcription differed from the index. */
    corrections: CodeCorrection[];
  };
  usage: {
    /** Uncached prompt tokens, billed at full rate. */
    inputTokens: number;
    /** Prompt tokens written to cache this run, billed at ~1.25x. */
    cacheWriteTokens: number;
    /** Prompt tokens served from cache, billed at ~0.1x. */
    cacheReadTokens: number;
    outputTokens: number;
  };
  model: string;
  effort: string;
  htsusRevision: string;
  durationMs: number;
}

/**
 * Hosts `web_fetch` may retrieve.
 *
 * Deliberately short. Everything the classification *relies* on comes from the
 * pinned snapshot; the web is for product research and for reading a ruling the
 * search surfaced. Manufacturer datasheets live on arbitrary hosts, so part
 * research is served by `web_search` — whose results are summaries rather than
 * a channel the model can be induced to send data through — and by fetching
 * only from the authorities below.
 */
const WEB_FETCH_ALLOWED_DOMAINS = [
  "rulings.cbp.gov",
  "www.cbp.gov",
  "cbp.gov",
  "hts.usitc.gov",
  "www.usitc.gov",
  "www.census.gov",
  "www.federalregister.gov",
  "www.trade.gov",
];

/**
 * Does this error mean the request's compiled grammar was rejected as too big?
 *
 *   400 invalid_request_error — "The compiled grammar is too large, which
 *   would cause performance issues. Simplify your tool schemas or reduce the
 *   number of strict tools."
 *
 * The grammar spans the structured-output schema *and* every tool schema in
 * the request, and Anthropic publishes no size limit — so there is no number to
 * design against, and a schema that fits today can stop fitting when a tool is
 * added. Matched on status plus message text because the API exposes no
 * dedicated error code for it; a wording change degrades this to a hard
 * failure with the API's own message, which is the safe direction.
 */
export function isGrammarTooLarge(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError) || error.status !== 400) {
    return false;
  }
  return /compiled grammar is too large/i.test(error.message ?? "");
}

/**
 * Which container the next request should name.
 *
 * Only ever *adds* or *replaces* — never clears. A turn that reports no
 * container is not saying the sandbox is gone, merely that this message did
 * not open or use one; dropping the id there would strand any tool call still
 * pending inside it and reproduce the very rejection this exists to avoid.
 */
export function nextContainer(
  current: BetaMessageParams["container"],
  message: Pick<BetaMessage, "container">,
): BetaMessageParams["container"] {
  return message.container?.id ?? current ?? null;
}

export class ClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassificationError";
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  mode: AnalysisMode;
  input: string;
  refinements: Refinement[];
  signal?: AbortSignal;
}

/**
 * Run one classification, emitting progress as it goes.
 *
 * At `effort: max` with tool use, a single run legitimately takes minutes, so
 * the caller gets thinking summaries and tool activity rather than a silent
 * wait. The final structured answer arrives on the `done` event.
 */
export async function* classify(
  input: ClassifyInput,
): AsyncGenerator<ProgressEvent, void, undefined> {
  const startedAt = Date.now();

  // Checked before anything else, including the API key, so a replay session
  // needs no credentials at all. Every event the rest of the app sees is the
  // one a real run produced, and the run it ends on is stamped as replayed.
  const cassette = config.replayCassette;
  if (cassette) {
    yield {
      type: "status",
      message: `Replaying a recorded run from ${cassette}. No API call is being made.`,
    };
    yield* replayCassette(cassette, config.replayStepDelayMs);
    return;
  }

  let revision;
  try {
    revision = getActiveRevision();
  } catch (error) {
    yield {
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : "No HTSUS snapshot is available.",
    };
    return;
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const effort = config.effort;
  const capabilities = config.modelCapabilities;

  // Depth is set by an effort level on some models and a thinking budget on
  // others; the two are mutually exclusive and each is a 400 on the wrong
  // model. Build both fragments once here so the request below reads as one
  // shape rather than a pile of conditionals.
  const thinking =
    capabilities.thinking === "adaptive"
      ? // `summarized` is requested explicitly because the default omits the
        // text and the analyst is watching a multi-minute run.
        ({ type: "adaptive", display: "summarized" } as const)
      : ({ type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS } as const);

  const depth = effort
    ? `${effort} effort`
    : `a ${THINKING_BUDGET_TOKENS.toLocaleString()}-token thinking budget`;

  yield {
    type: "status",
    message: `Classifying against ${revision.revision} using ${config.model} at ${depth}.`,
  };

  /**
   * Build the run.
   *
   * `structuredOutput` selects how the final answer's shape is obtained:
   * enforced by the API's compiled grammar, or asked for in the prompt and
   * validated on the way back. See `buildOutputContract` for why the second
   * mode has to exist.
   */
  const buildRunner = (structuredOutput: boolean) =>
    client.beta.messages.toolRunner({
      model: config.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // The dominant cost of this app is not the model tier — it is that a
      // tool loop resends its whole accumulated history on every iteration.
      // A run that reads chapter notes and fetches a datasheet is re-billing
      // tens of thousands of tokens per step, so spend grows with the square
      // of the tool count. The static breakpoint on the system prompt below
      // does nothing for that: the growing part is the messages.
      //
      // Top-level cache control places a marker on the last cacheable block of
      // each request, which during the loop is the tool result just appended.
      // Every iteration therefore reads back the prior turn's prefix at ~0.1x
      // instead of paying full rate for it again.
      //
      // Done this way rather than by marking blocks through the runner
      // deliberately: `setMessagesParams` sets the runner's internal `mutated`
      // flag, which stops it appending the assistant turn, which is what sent
      // an earlier version of this loop into a 41-iteration spin. Passing a
      // parameter the runner forwards untouched cannot reach that code path.
      cache_control: { type: "ephemeral" },
      thinking,
      output_config: {
        // Omitted entirely, not set to a default, on models that reject it.
        ...(effort ? { effort } : {}),
        ...(structuredOutput
          ? { format: betaZodOutputFormat(resultSchemaFor(input.mode)) }
          : {}),
      },
      system: [
        {
          type: "text",
          text: structuredOutput
            ? buildSystemPrompt(input.mode)
            : `${buildSystemPrompt(input.mode)}\n\n${buildOutputContract(
                z.toJSONSchema(resultSchemaFor(input.mode)),
              )}`,
          // Stable prefix: prompt + tool definitions are identical across runs
          // and across the clarifying-question round trip, so a refinement
          // re-run is cheap. The two modes have different prefixes and so
          // different cache entries, which is correct — a deployment settles
          // into one of them and keeps that entry warm.
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        ...classificationTools,
        // The _20250305/_20250910 variants deliberately, not the newer
        // _20260209 pair. Those do their result filtering inside a code
        // execution sandbox, which means a turn can end with tool calls
        // originating in that sandbox, and continuing it requires naming the
        // container on every later request. The SDK's tool runner offers no
        // way to set that mid-run: `setMessagesParams` marks the params
        // mutated, and a mutated runner stops appending the assistant turn
        // to the conversation — so the model re-sends the same tool calls
        // forever until the iteration ceiling. Filtering is a token-efficiency
        // nicety; a loop that burns a fifteen-minute run is not a trade.
        { type: "web_search_20250305", name: "web_search", max_uses: 12 },
        {
          type: "web_fetch_20250910",
          name: "web_fetch",
          max_uses: 8,
          // Fetching is the one tool that can send data outward, and the inputs
          // here are customer part numbers and unreleased product descriptions.
          // Without a domain limit, a page reached during part research can
          // instruct the model to fetch an attacker-controlled URL with the part
          // number in the query string, and eight fetches is ample to exfiltrate
          // an item master. The allowlist is the authorities the analysis is
          // actually meant to read plus manufacturer research; widen it
          // deliberately rather than by removing it.
          allowed_domains: WEB_FETCH_ALLOWED_DOMAINS,
          // A fetched datasheet can otherwise add five figures of tokens to the
          // history, which is then re-billed on every subsequent tool iteration.
          // Scaled to the model's context: 30k is 3% of a 1M window and 15% of
          // a 200k one, and two such fetches plus the chapter notes a GRI walk
          // pulls will crowd a small window before the analysis is finished.
          max_content_tokens: Math.min(
            30_000,
            Math.floor(capabilities.contextTokens * 0.03),
          ),
        },
      ],
      messages: [
        {
          role: "user",
          content: buildUserTurn({
            mode: input.mode,
            input: input.input,
            htsusRevision: revision.revision,
            revisionPublished: revision.publishedDate,
            refinements: input.refinements,
          }),
        },
      ],
      max_iterations: MAX_TOOL_ITERATIONS,
      stream: true,
    });

  let runner = buildRunner(true);
  if (input.signal) {
    runner.setRequestOptions({ signal: input.signal });
  }

  let finalMessage: BetaMessage | null = null;
  let inputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let pauseResumes = 0;
  let structuredOutput = true;
  let iterations = 0;

  // One downgrade, at most. The grammar is compiled during request validation,
  // so a rejection lands before any tokens are generated and before anything
  // has been yielded to the analyst — re-running costs nothing and shows
  // nothing but a warning.
  for (;;) {
    try {
      for await (const stream of runner) {
        iterations += 1;
        // Buffer thinking deltas into sentence-ish chunks; per-token events
        // would flood the SSE channel for no readability gain.
        let thinkingBuffer = "";

        // A streaming tool_use block arrives empty and is filled in afterwards
        // by `input_json_delta`. Reporting it at content_block_start therefore
        // described every call with blank arguments — "searching the tariff for
        // \"\"" — which is not just cosmetic: it is the progress log an analyst
        // reads to see whether a multi-minute run is doing sensible work, and
        // it was showing nothing of the sort. Accumulate the JSON and report on
        // content_block_stop, which keeps the events live but complete.
        const pending = new Map<number, { name: string; json: string }>();

        for await (const event of stream) {
          if (event.type === "content_block_delta") {
            if (event.delta.type === "thinking_delta") {
              thinkingBuffer += event.delta.thinking;
              if (/[.!?]\s$|\n/.test(thinkingBuffer) && thinkingBuffer.length > 40) {
                yield { type: "thinking", text: thinkingBuffer.trim() };
                thinkingBuffer = "";
              }
            } else if (event.delta.type === "input_json_delta") {
              const entry = pending.get(event.index);
              if (entry) entry.json += event.delta.partial_json;
            }
            // Text deltas are suppressed: with a structured output format the
            // assistant's visible text is the JSON payload, which is not
            // something an analyst wants streamed at them.
          } else if (event.type === "content_block_start") {
            const block = event.content_block;
            if (block.type === "tool_use" || block.type === "server_tool_use") {
              pending.set(event.index, { name: block.name, json: "" });
            }
          } else if (event.type === "content_block_stop") {
            const entry = pending.get(event.index);
            if (entry) {
              pending.delete(event.index);
              let input: unknown = {};
              try {
                input = entry.json ? JSON.parse(entry.json) : {};
              } catch {
                // Partial or malformed JSON: report the call without its
                // arguments rather than dropping the event entirely.
              }
              yield {
                type: "tool_use",
                name: entry.name,
                summary: describeToolInput(entry.name, input),
              };
            }
          }
        }

        if (thinkingBuffer.trim()) {
          yield { type: "thinking", text: thinkingBuffer.trim() };
        }

        const message = await stream.finalMessage();
        finalMessage = message;
        // `input_tokens` is the *uncached remainder* only. Counting it alone
        // undercounts a cached run badly and — worse for a spend decision —
        // makes caching look like it did nothing, because the tokens it moved
        // simply vanish from the total. Track all three so the figure shown to
        // the analyst is the whole prompt and the saving is legible.
        inputTokens += message.usage?.input_tokens ?? 0;
        cacheWriteTokens += message.usage?.cache_creation_input_tokens ?? 0;
        cacheReadTokens += message.usage?.cache_read_input_tokens ?? 0;
        outputTokens += message.usage?.output_tokens ?? 0;

        // Server-side tools can pause a long turn. The runner only continues
        // after a *client* tool produces a result, so a paused turn would
        // otherwise end the loop silently with a truncated answer.
        if (message.stop_reason === "pause_turn") {
          pauseResumes += 1;
          if (pauseResumes > MAX_PAUSE_RESUMES) {
            yield {
              type: "warning",
              message: `Run paused ${pauseResumes} times and was stopped. The answer may be incomplete.`,
            };
            break;
          }
          yield {
            type: "status",
            message: "Resuming after a paused research step…",
          };
          runner.pushMessages({ role: "assistant", content: message.content });
        }

        if (message.stop_reason === "refusal") {
          yield {
            type: "error",
            message:
              "The model declined this request. If the product is dual-use or " +
              "security-related, rephrase around its physical characteristics.",
          };
          return;
        }

        if (message.stop_reason === "max_tokens") {
          yield {
            type: "warning",
            message:
              "The response hit the output token limit and may be truncated.",
          };
        }
      }
      break;
    } catch (error) {
      if (structuredOutput && finalMessage === null && isGrammarTooLarge(error)) {
        structuredOutput = false;
        inputTokens = 0;
        outputTokens = 0;
        pauseResumes = 0;
        // Status, not warning. Measured against the live API, this schema
        // does not fit the grammar limit and never will at its current size,
        // so the downgrade happens on every single run. A warning that always
        // fires is one an analyst learns to scroll past, which is precisely
        // how a warning that matters gets missed. The attempt is still made
        // first: it costs one rejected request, is not billed, and self-heals
        // if the limit ever moves.
        yield {
          type: "status",
          message:
            "Output schema too large to enforce; asking for the same shape in " +
            "the prompt and validating it on return.",
        };
        runner = buildRunner(false);
        if (input.signal) {
          runner.setRequestOptions({ signal: input.signal });
        }
        continue;
      }
      yield {
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "The classification run failed.",
      };
      return;
    }
  }

  if (!finalMessage) {
    yield { type: "error", message: "The model returned no response." };
    return;
  }

  // The tool runner stops at `max_iterations` without saying so: it simply
  // stops yielding, and the last message is whatever the model was in the
  // middle of. A turn that ends still asking for a tool is that case, and it
  // is worth naming — the alternative is a confusing "no final answer" from
  // the parser, several minutes and a real amount of money after the run
  // could have been recognised as doomed.
  if (finalMessage.stop_reason === "tool_use") {
    const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);
    yield {
      type: "error",
      message:
        `The analysis was still working after ${iterations} tool steps ` +
        `(${elapsedMin} min) and hit its ${MAX_TOOL_ITERATIONS}-step ceiling ` +
        `before reaching a determination. Nothing was saved. This usually ` +
        `means the input sent it hunting — a part number it could not pin ` +
        `down, or a product spanning several chapters. Try again with the ` +
        `product described directly rather than by part number, or narrow ` +
        `the description.`,
    };
    return;
  }

  console.log(
    `[classify] finished: ${iterations} tool step(s), ` +
      `${Math.round((Date.now() - startedAt) / 1000)}s, ` +
      `stop_reason=${finalMessage.stop_reason}, ` +
      `structuredOutput=${structuredOutput}`,
  );

  yield { type: "status", message: "Verifying codes against the tariff…" };

  let parsed: ClassificationResult;
  try {
    parsed = parseResult(finalMessage, input.mode);
  } catch (error) {
    yield {
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : "The model's response could not be read.",
    };
    return;
  }

  const { result, verification } = verifyAgainstTariff(parsed);

  for (const rejected of verification.rejectedCodes) {
    yield {
      type: "warning",
      message: `Dropped ${rejected.code}: ${rejected.reason}`,
    };
  }

  if (result.candidates.length === 0 && result.status === "complete") {
    yield {
      type: "error",
      message:
        "Every code returned failed verification against the active tariff " +
        "revision. Nothing was saved. This usually means the run went wrong — " +
        "re-run, and if it recurs, check that the HTSUS snapshot is complete.",
    };
    return;
  }

  yield {
    type: "done",
    run: {
      result,
      verification,
      usage: { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens },
      model: config.model,
      effort: config.effortLabel,
      htsusRevision: revision.revision,
      durationMs: Date.now() - startedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Pull the JSON object out of the model's final message.
 *
 * Under `output_config.format` the text *is* the object and this returns it
 * untouched. Under the prompt-only fallback nothing enforces that, so the two
 * things a model actually does — wrap the object in a ```json fence, or add a
 * sentence around it — are handled here rather than failing the run. Anything
 * beyond that is a genuine malformation and should surface as one.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{")) return inner;
  }

  // Fall back to the outermost brace span.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) return trimmed.slice(first, last + 1);

  return trimmed;
}

function parseResult(
  message: BetaMessage,
  mode: AnalysisMode,
): ClassificationResult {
  const text = message.content
    .filter((block): block is { type: "text"; text: string } & typeof block =>
      block.type === "text",
    )
    .map((block) => block.text)
    .join("");

  if (!text.trim()) {
    throw new ClassificationError(
      "The model produced no final answer. This can happen if the tool loop " +
        "hit its iteration cap — try a narrower product description.",
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(extractJsonObject(text));
  } catch {
    throw new ClassificationError(
      "The model's final answer was not valid JSON.",
    );
  }

  const validated = resultSchemaFor(mode).safeParse(json);
  if (!validated.success) {
    throw new ClassificationError(
      `The model's answer did not match the expected shape: ${validated.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  // Description mode omits `researched_product` from the schema entirely —
  // nothing was researched — so restore the null the rest of the app expects.
  return { researched_product: null, ...validated.data };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Check every code the model returned against the tariff, and replace the
 * purely factual fields with the index's values.
 *
 * A fabricated but well-formed 10-digit number is the highest-consequence
 * failure mode in this domain, and it is exactly the kind of thing a language
 * model produces fluently. Duty rates and description paths are lookups, not
 * judgements, so where the model's transcription disagrees with the tariff the
 * tariff wins and the disagreement is recorded.
 */
/**
 * The export-side half of the anti-fabrication check.
 *
 * A wrong Schedule B number is filed on the EEI and carries its own penalty
 * exposure, so it gets the same treatment as the HTS code: confirm the code
 * exists in the snapshot, and let the schedule — not the model's transcription
 * — supply the description and units.
 *
 * A code from a different HS subheading than the HTS number is *not* rejected.
 * Roughly 0.6% of tariff subheadings have no export counterpart, and for those
 * the only route is `schedule_b_search`, which legitimately crosses
 * subheadings. It is recorded instead, so a reviewer sees the divergence.
 */
/**
 * Chapter 99 provisions get the same treatment as the base code.
 *
 * An invented "+25% Section 301" line is a larger duty-exposure error than most
 * base-rate mistakes, and it renders in a callout headed ADDITIONAL DUTIES MAY
 * APPLY — the part of the determination a reader is most likely to act on. The
 * provision must exist in this revision and must actually be a Chapter 99
 * subheading; the duty text is then read from the tariff rather than from the
 * model's transcription.
 */
function verifyChapter99(
  candidate: Candidate,
  htsNo: string,
  sink: {
    rejectedCodes: { code: string; reason: string }[];
    corrections: CodeCorrection[];
  },
): Candidate["tariff"]["chapter_99"] {
  const kept: Candidate["tariff"]["chapter_99"] = [];

  for (const entry of candidate.tariff.chapter_99) {
    const line = lookupExact(entry.hts_code);
    if (!line) {
      sink.rejectedCodes.push({
        code: entry.hts_code,
        reason: "Chapter 99 provision not present in this HTSUS revision",
      });
      continue;
    }
    if (!line.digits.startsWith("99")) {
      sink.rejectedCodes.push({
        code: entry.hts_code,
        reason: `resolves to ${line.htsNo}, which is not a Chapter 99 provision`,
      });
      continue;
    }

    // The published duty text lives on the provision itself.
    const published = line.general || line.additionalDuties || "";
    if (published && entry.additional_duty.trim() !== published) {
      sink.corrections.push({
        htsCode: htsNo,
        field: `chapter_99[${line.htsNo}].additional_duty`,
        modelValue: entry.additional_duty,
        indexValue: published,
      });
    }

    kept.push({
      ...entry,
      hts_code: line.htsNo,
      additional_duty: published || entry.additional_duty,
    });
  }

  return kept;
}

/**
 * CBP ruling number formats.
 *
 * CBP has changed this scheme several times and every generation is still live
 * in CROSS and still cited in current practice, so the pattern has to admit all
 * of them:
 *
 *   HQ 967890      six digits, no letter — the older HQ series
 *   HQ H289712     H + six digits — current HQ
 *   HQ W968156     W + six digits — pre-classification rulings
 *   NY N123456     N + six digits — current NY
 *   NY J80123      letter + five digits — the 2002-2005 NY series, where the
 *                  letter advanced roughly yearly (I, J, K, L, R and others)
 *
 * The previous pattern accepted only `[HN]?\d{6}`, which rejected the entire
 * letter-plus-five-digit generation and W-prefixed HQ rulings. That mattered
 * more than a missed citation: a rejection here is written into the
 * determination's discarded list as "not a CBP ruling number format", so the
 * document told a reader, in writing, that a genuine CBP citation was malformed.
 *
 * Still deliberately structural. A well-formed number is not a real ruling, and
 * only fetching it from CROSS would establish that — see verifyCrossRulings.
 */
const RULING_NUMBER = /^(?:HQ|NY)?\s*(?:[A-Z]\d{5,6}|\d{6})$/i;

/**
 * Structural screening for cited rulings.
 *
 * This is deliberately weaker than the code checks, and the difference is worth
 * being explicit about: a ruling can only be *confirmed* by fetching it from
 * CROSS, which is a network call this function does not make. What it can do is
 * reject citations that could not possibly be real — a ruling number in the
 * wrong shape, or a link pointing somewhere other than CBP's database — and
 * ensure the link actually references the ruling it claims to.
 *
 * Everything surviving is still only *cited*, not verified, and the UI and the
 * PDF say so rather than presenting it as a checked authority.
 */
function verifyCrossRulings(
  candidate: Candidate,
  sink: { rejectedCodes: { code: string; reason: string }[] },
): Candidate["cross_rulings"] {
  const kept: Candidate["cross_rulings"] = [];

  for (const ruling of candidate.cross_rulings) {
    const number = ruling.ruling_number.trim();
    if (!RULING_NUMBER.test(number)) {
      sink.rejectedCodes.push({
        code: number || "(no ruling number)",
        reason: "not a CBP ruling number format",
      });
      continue;
    }

    let host: string;
    try {
      host = new URL(ruling.url).hostname.toLowerCase();
    } catch {
      sink.rejectedCodes.push({
        code: number,
        reason: `citation URL is not a valid URL (${ruling.url})`,
      });
      continue;
    }

    if (host !== "rulings.cbp.gov" && !host.endsWith(".cbp.gov")) {
      sink.rejectedCodes.push({
        code: number,
        reason: `citation links to ${host}, not CBP's ruling database`,
      });
      continue;
    }

    const digits = number.replace(/\D/g, "");
    if (digits && !ruling.url.replace(/\D/g, "").includes(digits)) {
      sink.rejectedCodes.push({
        code: number,
        reason: "citation URL does not reference the ruling number it cites",
      });
      continue;
    }

    kept.push(ruling);
  }

  return kept;
}

function verifyScheduleB(
  candidate: Candidate,
  htsNo: string,
  sink: {
    rejectedCodes: { code: string; reason: string }[];
    corrections: CodeCorrection[];
  },
): Candidate["schedule_b"] {
  const claimed = candidate.schedule_b;
  if (!claimed) return null;

  const entry = lookupScheduleB(claimed.code);
  if (!entry) {
    sink.rejectedCodes.push({
      code: claimed.code,
      reason: "Schedule B code not present in this edition of the export schedule",
    });
    return null;
  }

  if (claimed.description.trim() !== entry.description) {
    sink.corrections.push({
      htsCode: htsNo,
      field: "schedule_b.description",
      modelValue: claimed.description,
      indexValue: entry.description,
    });
  }

  const htsHs6 = htsNo.replace(/\D/g, "").slice(0, 6);
  if (htsHs6.length === 6 && entry.hs6 !== htsHs6) {
    sink.corrections.push({
      htsCode: htsNo,
      field: "schedule_b.hs_subheading",
      modelValue: `export code sits under ${entry.hs6}`,
      indexValue: `HTS number sits under ${htsHs6}`,
    });
  }

  return {
    ...claimed,
    code: entry.htsNo,
    description: entry.description,
    unit_of_quantity: entry.units,
  };
}

export function verifyAgainstTariff(result: ClassificationResult): {
  result: ClassificationResult;
  verification: ClassificationRun["verification"];
} {
  const verifiedCodes: string[] = [];
  const rejectedCodes: { code: string; reason: string }[] = [];
  const corrections: CodeCorrection[] = [];

  const kept: Candidate[] = [];

  for (const candidate of result.candidates) {
    const line = lookupExact(candidate.hts_code);

    if (!line) {
      rejectedCodes.push({
        code: candidate.hts_code,
        reason: "not present in this HTSUS revision",
      });
      continue;
    }

    if (!line.isReportable) {
      rejectedCodes.push({
        code: candidate.hts_code,
        reason: `resolves to a ${line.digits.length}-digit line, which cannot be declared on an entry`,
      });
      continue;
    }

    verifiedCodes.push(line.htsNo);

    const authoritativePath = line.descriptionPath.filter(Boolean);
    if (
      authoritativePath.join(" > ") !== candidate.description_path.join(" > ")
    ) {
      corrections.push({
        htsCode: line.htsNo,
        field: "description_path",
        modelValue: candidate.description_path.join(" > "),
        indexValue: authoritativePath.join(" > "),
      });
    }
    if (candidate.tariff.duty.general !== line.general) {
      corrections.push({
        htsCode: line.htsNo,
        field: "duty.general",
        modelValue: candidate.tariff.duty.general,
        indexValue: line.general,
      });
    }

    kept.push({
      ...candidate,
      hts_code: line.htsNo,
      description_path: authoritativePath,
      tariff: {
        duty: {
          general: line.general,
          special: line.special,
          column_2: line.other,
          rates_published_on: line.ratesInheritedFrom,
        },
        unit_of_quantity: line.units,
        chapter_99: verifyChapter99(candidate, line.htsNo, {
          rejectedCodes,
          corrections,
        }),
      },
      schedule_b: verifyScheduleB(candidate, line.htsNo, {
        rejectedCodes,
        corrections,
      }),
      cross_rulings: verifyCrossRulings(candidate, { rejectedCodes }),
    });
  }

  // Re-rank so ranks stay contiguous after any drops.
  kept.sort((a, b) => a.rank - b.rank);
  const reRanked = kept.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
    reasoning: {
      ...candidate.reasoning,
      why_not_selected:
        index === 0 ? null : candidate.reasoning.why_not_selected,
    },
  }));

  // A null recommendation is a deliberate answer, not a missing one: the schema
  // requires it when status is "needs_more_info", i.e. the model is saying it
  // cannot responsibly pick yet. Promoting rank 1 into that slot converts a
  // refusal into a recommendation, and the UI pre-selects it — which is one
  // click from a signed determination the model declined to make.
  const modelDeclinedToRecommend = result.recommended_hts_code === null;
  const recommendedStillValid =
    !modelDeclinedToRecommend &&
    verifiedCodes.some(
      (code) =>
        code.replace(/\D/g, "") ===
        (result.recommended_hts_code ?? "").replace(/\D/g, ""),
    );

  return {
    result: {
      ...result,
      candidates: reRanked,
      recommended_hts_code: modelDeclinedToRecommend
        ? null
        : recommendedStillValid
          ? (reRanked.find(
              (candidate) =>
                candidate.hts_code.replace(/\D/g, "") ===
                (result.recommended_hts_code ?? "").replace(/\D/g, ""),
            )?.hts_code ?? null)
          : // The recommendation itself failed verification. Falling back to the
            // best surviving candidate is right here — the model did commit to
            // an answer, it just named one that does not exist.
            (reRanked[0]?.hts_code ?? null),
    },
    verification: { verifiedCodes, rejectedCodes, corrections },
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function describeToolInput(name: string, rawInput: unknown): string {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const str = (key: string): string =>
    typeof input[key] === "string" ? (input[key] as string) : "";

  switch (name) {
    case "hts_search":
      return `searching the tariff for "${str("query")}"`;
    case "hts_lookup":
      return `verifying ${str("hts_code")}`;
    case "hts_subtree":
      return `reading the breakouts under ${str("hts_code")}`;
    case "hts_notes":
      return `reading ${str("kind")} ${str("reference")} notes`;
    case "hts_gri":
      return "reading the General Rules of Interpretation";
    case "chapter99_lookup":
      return `checking Chapter 99 duties for ${str("hts_code")}`;
    case "schedule_b_lookup":
      return `listing Schedule B export codes for ${str("hts_code")}`;
    case "schedule_b_search":
      return `searching the export schedule for "${str("query")}"`;
    case "web_search":
      return `searching the web for "${str("query")}"`;
    case "web_fetch":
      return `reading ${str("url")}`;
    default:
      return name;
  }
}
