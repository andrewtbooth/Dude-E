"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AnalysisMode, Refinement } from "@/lib/agent/schema";
import { startRunDetached } from "@/lib/startRun";

/**
 * Start a re-run of a saved analysis, from a page that will not stream it.
 *
 * Shared by the two things a saved analysis can be given: answers to the
 * decisive questions, and the facts the model said would firm the call up.
 * Both do exactly the same thing to the row — merge refinements in, set it
 * RUNNING, hand off to `RunningWatcher` — so the difference between them is
 * which form is on screen, not what happens when it is submitted.
 */
export function useSavedAnalysisRun({
  analysisId,
  mode,
  input,
}: {
  analysisId: string;
  mode: AnalysisMode;
  input: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(refinements: Refinement[]) {
    setBusy(true);
    setError(null);
    try {
      const started = await startRunDetached({
        analysisId,
        mode,
        input,
        refinements,
      });
      if (!started.ok) {
        setError(started.error);
        return;
      }
      // Re-render the server component: the analysis is RUNNING now, so the
      // page picks up its own watcher and refreshes again when it finishes.
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The answers could not be submitted.",
      );
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, submit };
}
