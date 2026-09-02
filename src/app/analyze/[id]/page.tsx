import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BottomNav } from "@/components/BottomNav";
import { RefineSavedAnalysis } from "@/components/RefineSavedAnalysis";
import { ResumeAnalysis } from "@/components/ResumeAnalysis";
import { RunningWatcher } from "@/components/RunningWatcher";
import { Masthead } from "@/components/Masthead";
import { RunResult } from "@/components/RunResult";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { tryGetActiveRevision } from "@/lib/hts/store";
import { parseStoredRun } from "@/lib/pdf/buildView";

export const dynamic = "force-dynamic";

/**
 * One saved analysis, re-opened.
 *
 * Every run was already persisted; there was simply no route that could show
 * one, which made a dropped connection unrecoverable in the UI and left the
 * unresolved-analyses list on the history page pointing nowhere. The result is
 * rendered through the same component the live page uses, so what an analyst
 * reads here is what they would have read while it streamed.
 *
 * Not read-only with respect to the model, and it used to be. Selecting a code
 * and recording a determination act on the stored run, so those always worked;
 * answering a clarifying question means running the analysis again, and this
 * page simply did not offer it. That made a `needs_more_info` run unrecoverable
 * the moment nobody was watching the stream — the run cannot be recorded,
 * because the model declined to conclude, and it could not be answered either.
 * A full max-effort spend, stranded, with retyping the description as a fresh
 * analysis the only way on. See RefineSavedAnalysis.
 */
export default async function SavedAnalysisPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");

  const { id } = await params;
  const analysis = await prisma.analysis.findUnique({
    where: { id },
    include: { analyst: true, determinations: { orderBy: { decidedAt: "desc" } } },
  });

  if (!analysis) notFound();

  // Scoped to the owner, matching the refine route. An analysis is the
  // reasoning behind someone's signed determination; it is not a shared
  // document, and an id is not an access grant.
  if (analysis.analystId !== session.id) notFound();

  /**
   * Why this analysis is stopped, when it is.
   *
   * Deliberately does not include "still marked RUNNING but nothing is driving
   * it". That needs a clock, a server component may not read one during render,
   * and RunningWatcher already owns the question — it polls, and it knows when
   * it has given up. The offer is built here and handed to it.
   */
  const resumeReason =
    analysis.status === "CANCELLED"
      ? ("cancelled" as const)
      : analysis.status === "FAILED"
        ? ("failed" as const)
        : null;

  const revision = tryGetActiveRevision();
  const run = parseStoredRun(analysis.resultJson);

  return (
    <div className="min-h-dvh">
      <Masthead session={session} active="analyze" />

      <main className="mx-auto max-w-4xl space-y-6 px-5 py-8 pb-[calc(3.5rem+env(safe-area-inset-bottom)+2rem)] sm:pb-8">
        <header>
          <Link
            href="/history"
            className="text-xs text-[var(--text-muted)] underline underline-offset-2"
          >
            ← History
          </Link>
          <h1 className="mt-2 text-lg font-semibold tracking-tight text-[var(--text-primary)]">
            {analysis.mode === "PART_NUMBER" ? "Part number" : "Product description"}
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{analysis.input}</p>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Run by {analysis.analyst.name} · {analysis.createdAt.toISOString()} ·{" "}
            {analysis.model}, {analysis.effort} effort · {analysis.htsusRevision}
          </p>
        </header>

        {analysis.determinations.length > 0 && (
          <section className="rounded-lg border border-[var(--ok)] bg-[var(--ok-subtle)] p-4">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              A determination has already been recorded from this analysis
            </h2>
            <ul className="mt-2 space-y-1">
              {analysis.determinations.map((determination) => (
                <li key={determination.id} className="text-xs text-[var(--text-secondary)]">
                  <span className="hts-code">{determination.selectedHtsCode}</span>{" "}
                  by {determination.analystName} on{" "}
                  {determination.decidedAt.toISOString()} ·{" "}
                  <a
                    href={`/api/determinations/${determination.id}/pdf`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] underline underline-offset-2"
                  >
                    PDF
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              Recording another would leave two signed conclusions for one piece
              of work. Re-issue the existing document unless the first decision
              was genuinely wrong.
            </p>
          </section>
        )}

        {analysis.status === "RUNNING" && (
          <div
            role="status"
            className="rounded-lg border border-[var(--warn)] bg-[var(--warn-subtle)] px-4 py-3 text-sm text-[var(--text-primary)]"
          >
            This analysis is still running. A full run takes several minutes,
            and the result is written when it finishes whether or not anyone is
            watching.
            <RunningWatcher
              analysisId={analysis.id}
              startedAt={analysis.createdAt.toISOString()}
              stalledSlot={
                <ResumeAnalysis
                  analysisId={analysis.id}
                  mode={analysis.mode === "PART_NUMBER" ? "PART_NUMBER" : "DESCRIPTION"}
                  input={analysis.input}
                  reason="stalled"
                />
              }
            />
          </div>
        )}

        {analysis.status === "FAILED" && analysis.error && (
          <div
            role="alert"
            className="rounded-lg border border-[var(--danger)] bg-[var(--danger-subtle)] px-4 py-3"
          >
            <p className="text-sm text-[var(--danger)]">This analysis failed.</p>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              {analysis.error}
            </p>
          </div>
        )}

        {/*
          A stopped run is an offer to start again, not a dead end. Before this,
          the only route onward from a cancelled or failed analysis was retyping
          the description into a fresh one — losing the row, and with it every
          answer already given across every round.
        */}
        {resumeReason && (
          <ResumeAnalysis
            analysisId={analysis.id}
            mode={analysis.mode === "PART_NUMBER" ? "PART_NUMBER" : "DESCRIPTION"}
            input={analysis.input}
            reason={resumeReason}
          />
        )}

        {run ? (
          <RunResult
            run={run}
            analysisId={analysis.id}
            tariffRetrievedAt={
              revision ? new Date(revision.retrievedAt).toISOString().slice(0, 10) : null
            }
            // Answering re-runs the analysis rather than streaming it here, so
            // the questions are handed to a component that starts the run and
            // lets this page's own watcher pick it up. Suppressed while a run
            // is already in flight: the questions on screen belong to the round
            // that has just been superseded.
            questionsSlot={
              analysis.status === "RUNNING" || resumeReason !== null ? undefined : (
                <RefineSavedAnalysis
                  analysisId={analysis.id}
                  mode={analysis.mode === "PART_NUMBER" ? "PART_NUMBER" : "DESCRIPTION"}
                  input={analysis.input}
                  questions={run.result.clarifying_questions}
                />
              )
            }
          />
        ) : (
          analysis.status !== "RUNNING" &&
          resumeReason === null && (
            <p className="text-sm text-[var(--text-secondary)]">
              No result was stored for this analysis.
            </p>
          )
        )}
      </main>

      <BottomNav active="analyze" />
    </div>
  );
}
