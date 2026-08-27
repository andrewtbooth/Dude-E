"use client";

import type { AnalysisMode } from "@/lib/agent/schema";
import { StrengthenAnalysis } from "./StrengthenAnalysis";
import { useSavedAnalysisRun } from "./useSavedAnalysisRun";

/**
 * The optional round, on a saved analysis.
 *
 * The sibling of RefineSavedAnalysis, and it exists for the same reason: the
 * saved view can start a run perfectly well, and leaving it read-only meant an
 * analyst who arrived from History — which is where they arrive, because the
 * whole point of that page is a run they stopped watching — saw the gaps and
 * could do nothing about them.
 */
export function StrengthenSavedAnalysis({
  analysisId,
  mode,
  input,
  items,
}: {
  analysisId: string;
  mode: AnalysisMode;
  input: string;
  items: string[];
}) {
  const { busy, error, submit } = useSavedAnalysisRun({ analysisId, mode, input });

  return (
    <>
      <StrengthenAnalysis items={items} busy={busy} onSubmit={submit} />
      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </>
  );
}
