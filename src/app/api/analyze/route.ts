import { NextResponse } from "next/server";
import { APP_VERSION, config } from "@/lib/config";
import { classify } from "@/lib/agent/classify";
import { registerRun, releaseRun } from "@/lib/agent/runRegistry";
import type { AnalysisMode } from "@/lib/agent/schema";
import { UnauthenticatedError, requireSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { tryGetActiveRevision } from "@/lib/hts/store";
import { clientKey, rateLimit } from "@/lib/rateLimit";
import {
  mergeRefinements,
  parseRefinements,
  safeParseJson,
} from "./refinements";

export const runtime = "nodejs";
/** A max-effort run with tool use legitimately takes minutes. */
export const maxDuration = 800;

interface AnalyzeRequest {
  mode?: unknown;
  input?: unknown;
  analysisId?: unknown;
  refinements?: unknown;
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
  let mergedRefinements = refinements;

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

  // The read and the merge happen inside the write.
  //
  // Merging in application memory between a `findUnique` and an `update` is a
  // read-modify-write, and this is not a rare race: a round takes minutes, the
  // form stays interactive, and a retried or double-submitted POST is ordinary.
  // Two rounds in flight both read the same prior and the second write erases
  // the first's answers — which is precisely the loss the merge was written to
  // stop, reintroduced one layer down. The transaction is what makes "later
  // answers win" true rather than "whichever write lands last wins".
  const analysis = priorAnalysisId
    ? await prisma.$transaction(async (tx) => {
        const current = await tx.analysis.findUniqueOrThrow({
          where: { id: priorAnalysisId },
          select: { refinementsJson: true },
        });
        mergedRefinements = mergeRefinements(
          parseRefinements(safeParseJson(current.refinementsJson)),
          refinements,
        );
        return tx.analysis.update({
          where: { id: priorAnalysisId },
          data: {
            status: "RUNNING",
            refinementsJson: JSON.stringify(mergedRefinements),
            error: null,
            completedAt: null,
          },
        });
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
   * So writes become no-ops once the consumer is gone. The run itself is not
   * cancelled: by the time a browser drops, most of the cost of an analysis has
   * already been incurred, and abandoning it converts money already spent into
   * nothing at all. Letting it finish means the result still lands in the
   * database and shows up under History, so a closed tab costs the analyst
   * their place in the progress log rather than their analysis.
   *
   * That was the intent from the beginning and it was not what happened. The
   * run was given `request.signal`, which Next aborts the moment the client
   * disconnects — so closing the tab killed the analysis and wrote the row
   * FAILED, while this comment and the "Stop watching" button both said the
   * opposite. The run now carries its own controller (see runRegistry), and the
   * only things that abort it are an explicit cancel and a newer run replacing
   * it.
   */
  let consumerGone = false;

  // Registered before the stream opens so a cancel arriving in the first
  // seconds of a run has something to find.
  const runController = registerRun(analysis.id);

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
          // The merged set, not the request body's. The model is re-run from
          // scratch on every round, so anything left out here is a fact it was
          // told once and is no longer being told.
          refinements: mergedRefinements,
          // The run's own signal, never the request's. This is the whole
          // difference between a closed tab costing the analyst their progress
          // log and costing them the analysis.
          signal: runController.signal,
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
            // Scoped to a row still RUNNING. A cancel writes CANCELLED and then
            // aborts, but the abort can lose the race with a result already on
            // its way back — and a cancelled analysis that quietly turns
            // COMPLETE is a run the analyst stopped, presented as one they
            // waited for.
            await prisma.analysis.updateMany({
              where: { id: analysis.id, status: "RUNNING" },
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
            await prisma.analysis.updateMany({
              where: { id: analysis.id, status: "RUNNING" },
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

        // An abort is not a failure, and the reason it stopped is already on
        // the row: the cancel route wrote CANCELLED before it reached in here.
        // Recording "FAILED: This operation was aborted" over the top would
        // describe a deliberate act as a malfunction, and put a stack-shaped
        // message in front of an analyst who pressed a button.
        if (runController.signal.aborted) {
          console.warn(
            `[analyze] ${analysis.id} aborted after ${Date.now() - startedAt}ms`,
          );
          send({
            type: "error",
            message: "This run was stopped. You can resume it from the analysis page.",
          });
          return;
        }

        // Server-side too: when the consumer has gone there is nobody left to
        // show this to, and the row below is the only record of what happened.
        console.error(
          `[analyze] ${analysis.id} failed after ` +
            `${Date.now() - startedAt}ms: ${message}`,
          error,
        );

        await prisma.analysis
          .updateMany({
            where: { id: analysis.id, status: "RUNNING" },
            data: { status: "FAILED", error: message, completedAt: new Date() },
          })
          .catch(() => {
            // The run already failed; a failed status write should not mask it.
          });
        send({ type: "error", message });
      } finally {
        releaseRun(analysis.id, runController);
        try {
          controller.close();
        } catch {
          // Already closed by a cancel. Nothing to do, and throwing here would
          // replace the real error with a second controller complaint.
        }
      }
    },

    cancel() {
      // The consumer went away — a closed tab, a locked phone, "Stop watching".
      // Stop writing to a stream nobody is reading. The run is untouched: it
      // holds its own controller, and only an explicit cancel aborts it.
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
