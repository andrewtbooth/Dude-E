"use client";

import { useCallback, useRef, useState } from "react";
import type { ClassificationRun, ProgressEvent } from "@/lib/agent/classify";
import type { AnalysisMode, Refinement } from "@/lib/agent/schema";
import { readSseStream } from "@/lib/sse";
import { ProgressLog, type ProgressEntry } from "./ProgressLog";
import { RunResult } from "./RunResult";

/**
 * What the SSE route emits. The agent's own `done` event is replaced by the
 * route with one that also carries the persisted analysis id, so it is
 * excluded here rather than left in the union.
 */
type StreamEvent =
  | Exclude<ProgressEvent, { type: "done" }>
  | { type: "analysis_started"; analysisId: string }
  | { type: "done"; analysisId: string; run: ClassificationRun };

const MODES: { value: AnalysisMode; label: string; placeholder: string; hint: string }[] =
  [
    {
      value: "DESCRIPTION",
      label: "Product description",
      placeholder:
        "Stainless steel vacuum-insulated water bottle, 32 oz, double-walled, screw cap with plastic lid, for retail sale…",
      hint: "Describe what the thing physically is: materials, construction, function, how it is put up for sale.",
    },
    {
      value: "PART_NUMBER",
      label: "Part number",
      placeholder: "e.g. 1734-IB8S or MFR-PN-00421",
      hint: "The part is researched on the web first, then classified from its physical characteristics.",
    },
  ];

export function AnalyzeClient({
  disabled,
  tariffRetrievedAt,
}: {
  disabled: boolean;
  /** Snapshot retrieval date, already formatted, for dating Chapter 99 duties. */
  tariffRetrievedAt: string | null;
}) {
  const [mode, setMode] = useState<AnalysisMode>("DESCRIPTION");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [entries, setEntries] = useState<ProgressEntry[]>([]);
  const [run, setRun] = useState<ClassificationRun | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [droppedAnalysisId, setDroppedAnalysisId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const activeMode = MODES.find((entry) => entry.value === mode)!;

  const startRun = useCallback(
    async (refinements: Refinement[], continuingAnalysisId: string | null) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setRunning(true);
      setError(null);
      setRun(null);
      setDroppedAnalysisId(null);
      if (!continuingAnalysisId) setEntries([]);

      // Tracks whether the stream reached a terminal event. A dropped
      // connection ends the loop without one, and the run keeps going on the
      // server -- so the result exists, it just is not here.
      let settled = false;
      let startedId: string | null = continuingAnalysisId;

      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode,
            input,
            refinements,
            analysisId: continuingAnalysisId,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          setError(payload?.error ?? `Request failed (${response.status}).`);
          return;
        }

        for await (const event of readSseStream<StreamEvent>(
          response,
          controller.signal,
        )) {
          switch (event.type) {
            case "analysis_started":
              startedId = event.analysisId;
              setAnalysisId(event.analysisId);
              break;
            case "status":
              setEntries((prev) => [
                ...prev,
                { kind: "status", text: event.message },
              ]);
              break;
            case "thinking":
              setEntries((prev) => [
                ...prev,
                { kind: "thinking", text: event.text },
              ]);
              break;
            case "tool_use":
              setEntries((prev) => [
                ...prev,
                { kind: "tool", text: event.summary },
              ]);
              break;
            case "warning":
              setEntries((prev) => [
                ...prev,
                { kind: "warning", text: event.message },
              ]);
              break;
            case "done":
              // Deliberately not pre-selecting the recommendation. The next
              // click after this one records a determination under the
              // analyst's name, and when verification rejects the model's own
              // pick the runner falls back to the best surviving candidate --
              // a code the model never actually recommended. The card marks
              // the model's pick; choosing it is the analyst's action.
              settled = true;
              setAnalysisId(event.analysisId);
              setRun(event.run);
              break;
            case "error":
              settled = true;
              setError(event.message);
              break;
            default:
              break;
          }
        }
        // Falling out of the loop without a `done` or `error` frame means the
        // connection went away mid-run. The analysis itself keeps going on the
        // server and completes into a row — the result exists, it just is not
        // here. Previously the page showed nothing at all in this case: no
        // result, no error, no explanation, and no link to the row that was
        // still being written.
        if (!settled && startedId) setDroppedAnalysisId(startedId);
      } catch (caught) {
        if ((caught as Error).name !== "AbortError") {
          setError(
            caught instanceof Error
              ? caught.message
              : "The analysis could not be completed.",
          );
          // Same reasoning as above: a transport failure does not stop the run.
          if (startedId) setDroppedAnalysisId(startedId);
        }
      } finally {
        setRunning(false);
      }
    },
    [input, mode],
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (input.trim().length < 3) return;
    setAnalysisId(null);
    void startRun([], null);
  }

  function cancel() {
    abortRef.current?.abort();
    setRunning(false);
    setEntries((prev) => [
      ...prev,
      { kind: "warning", text: "Cancelled by analyst." },
    ]);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-3">
        <fieldset disabled={disabled || running}>
          <legend className="sr-only">What are you classifying?</legend>

          <div
            role="radiogroup"
            aria-label="Input type"
            className="inline-flex rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-0.5"
          >
            {MODES.map((entry) => (
              <button
                key={entry.value}
                type="button"
                role="radio"
                aria-checked={mode === entry.value}
                onClick={() => setMode(entry.value)}
                className={
                  mode === entry.value
                    ? "rounded px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--surface-1)] shadow-[var(--shadow-sm)]"
                    : "rounded px-3 py-1.5 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                }
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="mt-3">
            <label htmlFor="product-input" className="sr-only">
              {activeMode.label}
            </label>
            <textarea
              id="product-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              rows={mode === "PART_NUMBER" ? 2 : 4}
              placeholder={activeMode.placeholder}
              aria-describedby="product-input-hint"
              className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-60"
            />
            <p
              id="product-input-hint"
              className="mt-1.5 text-xs text-[var(--text-muted)]"
            >
              {activeMode.hint}
            </p>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={disabled || running || input.trim().length < 3}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {running ? "Analyzing…" : "Classify"}
          </button>
          {running && (
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)]"
            >
              Cancel
            </button>
          )}
          {running && (
            <span className="text-xs text-[var(--text-muted)]">
              A thorough run takes several minutes.
            </span>
          )}
        </div>
      </form>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-[var(--danger)] bg-[var(--danger-subtle)] px-4 py-3"
        >
          <p className="text-sm text-[var(--danger)]">{error}</p>
        </div>
      )}

      {droppedAnalysisId && !run && (
        <div
          role="status"
          className="rounded-lg border border-[var(--warn)] bg-[var(--warn-subtle)] px-4 py-3"
        >
          <p className="text-sm text-[var(--text-primary)]">
            The connection to this run dropped before it finished reporting.
          </p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            The analysis kept running on the server. Nothing has been lost and
            nothing needs re-running — open it once it settles.
          </p>
          <a
            href={`/analyze/${droppedAnalysisId}`}
            className="mt-2 inline-block text-xs font-medium text-[var(--accent)] underline underline-offset-2"
          >
            Open this analysis
          </a>
        </div>
      )}

      <ProgressLog entries={entries} running={running} />

      {run && (
        <RunResult
          run={run}
          analysisId={analysisId}
          tariffRetrievedAt={tariffRetrievedAt}
          busy={running}
          onRefine={(refinements) => void startRun(refinements, analysisId)}
        />
      )}
    </div>
  );
}
