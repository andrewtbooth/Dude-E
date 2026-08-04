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
          effort: config.effort,
          htsusRevision: revision.revision,
          scheduleBEdition: revision.scheduleBEdition,
          appVersion: APP_VERSION,
        },
      });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      send({ type: "analysis_started", analysisId: analysis.id });

      try {
        for await (const event of classify({
          mode,
          input,
          refinements,
          signal: request.signal,
        })) {
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
                inputTokens: run.usage.inputTokens,
                outputTokens: run.usage.outputTokens,
              },
            });
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
        controller.close();
      }
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
