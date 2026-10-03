"use client";

import type { AnalysisMode, ClarifyingQuestion } from "@/lib/agent/schema";
import { ClarifyingQuestions } from "./ClarifyingQuestions";
import { useSavedAnalysisRun } from "./useSavedAnalysisRun";

/**
 * Answer a saved run's clarifying questions, from the page you landed on.
 *
 * This was the sharpest defect an acceptance reviewer found, and it was a gap
 * between two things that both worked. A `needs_more_info` run cannot be
 * recorded — correctly, the model declined to conclude — so the only way
 * forward is to answer and re-run. The saved view rendered the questions
 * read-only and told the analyst the work "happens on the analysis page",
 * which is the page they were already on. Nothing anywhere re-attached a
 * stored analysis to a refinable run.
 *
 * So every way of not watching a stream to its end — the phone locking, the
 * tab being backgrounded, opening the row from History — stranded a full
 * max-effort run. And boundary goods, the ones an analyst actually wants help
 * with, are exactly the ones that come back asking questions and exactly the
 * ones you walk away from while they think.
 *
 * The fix does not stream. It posts the answers, reads only far enough to know
 * the server accepted them, and hands off to `RunningWatcher` — which already
 * exists for precisely this shape of problem, a run in flight that this page
 * is not consuming. The route keeps a run alive when its consumer goes away by
 * design, so releasing the body is not abandoning the analysis; it is the
 * documented path. The page then shows the run as RUNNING and refreshes itself
 * when it lands.
 *
 * Losing the live progress log is the trade. On the surface where an analyst
 * arrives *because* they stopped watching, that is not much of a loss.
 */
export function RefineSavedAnalysis({
  analysisId,
  mode,
  input,
  questions,
}: {
  analysisId: string;
  mode: AnalysisMode;
  input: string;
  questions: ClarifyingQuestion[];
}) {
  const { busy, error, submit } = useSavedAnalysisRun({
    analysisId,
    mode,
    input,
  });

  return (
    <>
      <ClarifyingQuestions
        questions={questions}
        busy={busy}
        onSubmit={(refinements) => void submit(refinements)}
      />
      {error && (
        <p
          role="alert"
          className="mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-subtle)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          {error}
        </p>
      )}
    </>
  );
}
