"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AnalysisMode } from "@/lib/agent/schema";
import { startRunDetached } from "@/lib/startRun";

/**
 * Start a stopped analysis again, on the row it already has.
 *
 * "Resume" is the honest word for what the analyst wants and not for what the
 * machine does. An agent run is a conversation with tool calls in it; there is
 * no half-finished state on disk to continue from, so this re-runs. What it
 * does preserve is everything that made the analysis *this* analysis — the same
 * row, the same input, and every answer the analyst has given across every
 * round, because the route merges the stored refinements back in. The
 * alternative on offer before this existed was retyping the description into a
 * fresh analysis and losing the thread that ties it to the questions already
 * answered.
 *
 * The tokens already spent are gone either way. That is a property of stopping
 * a run, not of this button, and the copy says so rather than implying the work
 * is recovered.
 */
export function ResumeAnalysis({
  analysisId,
  mode,
  input,
  reason,
}: {
  analysisId: string;
  mode: AnalysisMode;
  input: string;
  /** Why it stopped, so the offer can name it rather than describing a fault. */
  reason: "cancelled" | "failed" | "stalled";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    setBusy(true);
    setError(null);
    const started = await startRunDetached({ analysisId, mode, input });
    if (started.ok) {
      router.refresh();
    } else {
      setError(started.error);
    }
    setBusy(false);
  }

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <h2 className="text-sm font-semibold text-[var(--text-primary)]">
        {reason === "cancelled"
          ? "You stopped this run"
          : reason === "stalled"
            ? "This run stopped without finishing"
            : "This run did not finish"}
      </h2>

      <p className="mt-1 max-w-prose text-sm text-[var(--text-secondary)]">
        {reason === "cancelled"
          ? "Running it again starts a fresh analysis on this same record, with every answer you have already given carried over."
          : reason === "stalled"
            ? "Nothing has written to it for a while, so whatever was driving it is gone — most likely the server restarted mid-run. Running it again starts fresh on this same record, keeping your answers."
            : "Running it again starts fresh on this same record, keeping every answer you have already given."}
      </p>

      <button
        type="button"
        onClick={() => void resume()}
        disabled={busy}
        className="tap-target mt-3 justify-center rounded-md bg-[var(--accent)] px-5 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
      >
        {busy ? "Starting…" : "Run this analysis again"}
      </button>

      <p className="mt-2 text-xs text-[var(--text-muted)]">
        A new run costs what a run costs — the tokens already spent on the
        stopped one are not recovered.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-md border border-[var(--danger)] bg-[var(--danger-subtle)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          {error}
        </p>
      )}
    </section>
  );
}
