import { NextResponse } from "next/server";
import { APP_VERSION, config } from "@/lib/config";
import { classify } from "@/lib/agent/classify";
import type { AnalysisMode, Refinement } from "@/lib/agent/schema";
import { UnauthenticatedError, requireSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { tryGetActiveRevision } from "@/lib/hts/store";
import { clientKey, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
/** A max-effort run with tool use legitimately takes minutes. */
export const maxDuration = 800;

interface AnalyzeRequest {
  mode?: unknown;
  input?: unknown;
  analysisId?: unknown;
  refinements?: unknown;
}

function parseRefinements(raw: unknown): Refinement[] {
  if (!Array.isArray(raw)) return [];
  const parsed: Refinement[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const questionId = typeof record.questionId === "string" ? record.questionId : "";
    const question = typeof record.question === "string" ? record.question : "";
    const answer = typeof record.answer === "string" ? record.answer.trim() : "";
    if (questionId && question && answer) {
      parsed.push({ questionId, question, answer });
    }
  }
  return parsed;
}

export async function POST(request: Request) {
  let session;
  try {
    session = await requireSession();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    throw error;
  }

  // Sign-in records who decided; it does not gate anything, and on a publicly
  // reachable deployment that leaves the API budget as the exposed surface.
  // One request is a full max-effort agent run, so a handful of them is real
  // money. Keyed per client and per analyst so one of either cannot exhaust it.
  const limit = rateLimit(
    `analyze:${clientKey(request)}:${session.id}`,
    config.analyzeRateLimit,
    config.analyzeRateWindowMs,
  );
  if (!limit.ok) {
    return NextResponse.json(
      {
        error:
          `Rate limit reached — ${limit.limit} analyses per ` +
          `${Math.round(config.analyzeRateWindowMs / 60000)} minutes. ` +
          `Try again in ${limit.retryAfter}s.`,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const revision = tryGetActiveRevision();
  if (!revision) {
    return NextResponse.json(
      {
        error:
          "No HTSUS snapshot is loaded. Run `npm run sync:htsus` before analyzing — " +
          "classifying without a published edition to verify against would produce " +
          "codes nobody can check.",
      },
      { status: 503 },
    );
  }

  let body: AnalyzeRequest;
  try {
    body = (await request.json()) as AnalyzeRequest;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const mode: AnalysisMode =
    body.mode === "PART_NUMBER" ? "PART_NUMBER" : "DESCRIPTION";
  const input = typeof body.input === "string" ? body.input.trim() : "";
  const refinements = parseRefinements(body.refinements);
  const priorAnalysisId =
    typeof body.analysisId === "string" ? body.analysisId : null;

  if (input.length < 3) {
    return NextResponse.json(
      {
        error:
          mode === "PART_NUMBER"
            ? "Enter a part number."
            : "Describe the product in at least a few words.",
      },
      { status: 400 },
    );
  }
  if (input.length > 8000) {
    return NextResponse.json(
      { error: "Input is too long (8000 characters max)." },
      { status: 400 },
    );
  }

  // A refinement continues the same analysis record so the audit trail shows
  // one piece of work, not a series of disconnected runs. Scoping the update
  // to the signed-in analyst is what keeps that from also meaning "anyone
  // holding an id can rewrite someone else's run": this row's result is the
  // reasoning behind a determination, and an unscoped update would let one
  // analyst overwrite another's record of what was considered.
  if (priorAnalysisId) {
    const prior = await prisma.analysis.findUnique({
      where: { id: priorAnalysisId },
      select: { analystId: true },
    });
    if (!prior || prior.analystId !== session.id) {
      return NextResponse.json(
        { error: "That analysis belongs to another analyst." },
        { status: 403 },
      );
    }
  }

  const analysis = priorAnalysisId
    ? await prisma.analysis.update({
        where: { id: priorAnalysisId },
        data: {
          status: "RUNNING",
          refinementsJson: JSON.stringify(refinements),
          error: null,
          completedAt: null,
        },
      })
    : await prisma.analysis.create({
        data: {
          analystId: session.id,
          mode,
          input,
          refinementsJson: JSON.stringify(refinements),
          status: "RUNNING",
          model: config.model,
          effort: config.effortLabel,
          htsusRevision: revision.revision,
          scheduleBEdition: revision.scheduleBEdition,
          appVersion: APP_VERSION,
        },
      });

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  /**
   * Set when the consumer goes away.
   *
   * A run takes minutes, and the browser can disappear at any point in them —
   * a closed tab, a sleeping laptop, a proxy giving up. When it does, the
   * stream is cancelled and the controller closes, but `classify` keeps going,
   * because it is driven by this loop rather than by the socket. Every
   * subsequent `send` then throws "Invalid state: Controller is already
   * closed" — which lands in the catch below, whose own `send` throws the same
   * thing again, and *that* is the error that reaches the analyst and the
   * database. The genuine failure, if there was one, is gone.
   *
   * So writes become no-ops once the consumer is gone. The run itself is
   * deliberately *not* cancelled here: by the time a browser drops, most of the
   * cost of an analysis has already been incurred, and abandoning it converts
   * money already spent into nothing at all. Letting it finish means the result
   * still lands in the database and shows up under History, so a closed tab
   * costs the analyst their place in the progress log rather than their
   * analysis. (If the platform tears the request down it will abort via
   * `request.signal` regardless — that part is not ours to decide.)
   */
  let consumerGone = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        if (consumerGone) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          // Raced with a cancel between the check and the write. The consumer
          // is gone either way; losing this event is the correct outcome and
          // must not become the run's reported failure.
          consumerGone = true;
        }
      };

      send({ type: "analysis_started", analysisId: analysis.id });

      try {
        for await (const event of classify({
          mode,
          input,
          refinements,
          signal: request.signal,
        })) {
          // One line per tool call and status change. A run takes minutes and
          // can fail deep inside it; without this the only evidence of how far
          // it got is whatever reached the browser, which is precisely what is
          // lost when the browser is the thing that went away.
          if (event.type === "tool_use") {
            console.log(`[analyze] ${analysis.id} tool ${event.name}`);
          } else if (event.type === "status" || event.type === "warning") {
            console.log(`[analyze] ${analysis.id} ${event.type}: ${event.message}`);
          }

          if (event.type === "done") {
            const { run } = event;
            await prisma.analysis.update({
              where: { id: analysis.id },
              data: {
                status:
                  run.result.status === "needs_more_info"
                    ? "NEEDS_MORE_INFO"
                    : "COMPLETE",
                resultJson: JSON.stringify(run),
                completedAt: new Date(),
                durationMs: run.durationMs,
                // The whole prompt, not just the uncached remainder. A reader
                // asking "what did this run cost" wants every token that was
                // sent; splitting cached ones out of the recorded figure makes
                // a heavily-cached run look almost free.
                inputTokens:
                  run.usage.inputTokens +
                  run.usage.cacheWriteTokens +
                  run.usage.cacheReadTokens,
                outputTokens: run.usage.outputTokens,
              },
            });
            console.log(
              `[analyze] ${analysis.id} complete in ${run.durationMs}ms — ` +
                `${run.result.candidates.length} candidate(s), ` +
                `${run.usage.inputTokens} uncached + ` +
                `${run.usage.cacheWriteTokens} written + ` +
                `${run.usage.cacheReadTokens} cached in / ` +
                `${run.usage.outputTokens} out`,
            );
            send({ type: "done", analysisId: analysis.id, run });
          } else if (event.type === "error") {
            await prisma.analysis.update({
              where: { id: analysis.id },
              data: {
                status: "FAILED",
                error: event.message,
                completedAt: new Date(),
              },
            });
            send(event);
          } else {
            send(event);
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The analysis failed.";

        // Server-side too: when the consumer has gone there is nobody left to
        // show this to, and the row below is the only record of what happened.
        console.error(
          `[analyze] ${analysis.id} failed after ` +
            `${Date.now() - startedAt}ms: ${message}`,
          error,
        );

        await prisma.analysis
          .update({
            where: { id: analysis.id },
            data: { status: "FAILED", error: message, completedAt: new Date() },
          })
          .catch(() => {
            // The run already failed; a failed status write should not mask it.
          });
        send({ type: "error", message });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by a cancel. Nothing to do, and throwing here would
          // replace the real error with a second controller complaint.
        }
      }
    },

    cancel() {
      // The consumer went away. Stop writing to a stream nobody is reading,
      // but let the run finish so its result is still recorded.
      consumerGone = true;
      console.warn(
        `[analyze] ${analysis.id} client disconnected after ` +
          `${Date.now() - startedAt}ms; run continues so the result is kept`,
      );
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies that buffer will make a multi-minute run look frozen.
      "X-Accel-Buffering": "no",
    },
  });
}
