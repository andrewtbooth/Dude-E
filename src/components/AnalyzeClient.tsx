"use client";

import { useCallback, useRef, useState } from "react";
import type { ClassificationRun, ProgressEvent } from "@/lib/agent/classify";
import type { AnalysisMode, Refinement } from "@/lib/agent/schema";
import { readSseStream } from "@/lib/sse";
import { CandidateCard } from "./CandidateCard";
import { ClarifyingQuestions } from "./ClarifyingQuestions";
import { ProgressLog, type ProgressEntry } from "./ProgressLog";
import { ResultSummary } from "./ResultSummary";

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

export function AnalyzeClient({ disabled }: { disabled: boolean }) {
  const [mode, setMode] = useState<AnalysisMode>("DESCRIPTION");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [entries, setEntries] = useState<ProgressEntry[]>([]);
  const [run, setRun] = useState<ClassificationRun | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

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
      setSelectedCode(null);
      if (!continuingAnalysisId) setEntries([]);

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
              setAnalysisId(event.analysisId);
              setRun(event.run);
              setSelectedCode(event.run.result.recommended_hts_code);
              break;
            case "error":
              setError(event.message);
              break;
            default:
              break;
          }
        }
      } catch (caught) {
        if ((caught as Error).name !== "AbortError") {
          setError(
            caught instanceof Error
              ? caught.message
              : "The analysis could not be completed.",
          );
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

      <ProgressLog entries={entries} running={running} />

      {run && (
        <>
          <ResultSummary run={run} />

          {run.result.clarifying_questions.length > 0 && (
            <ClarifyingQuestions
              questions={run.result.clarifying_questions}
              busy={running}
              onSubmit={(refinements) => void startRun(refinements, analysisId)}
            />
          )}

          {run.result.candidates.length > 0 && (
            <section>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  Candidate classifications
                </h2>
                <p className="text-xs text-[var(--text-muted)]">
                  Select the code you are prepared to stand behind — it does not
                  have to be the model&rsquo;s pick.
                </p>
              </div>

              <ul className="space-y-3">
                {run.result.candidates.map((candidate) => (
                  <CandidateCard
                    key={candidate.hts_code}
                    candidate={candidate}
                    selected={selectedCode === candidate.hts_code}
                    onSelect={() => setSelectedCode(candidate.hts_code)}
                  />
                ))}
              </ul>

              <ExportBar
                analysisId={analysisId}
                selectedCode={selectedCode}
                disabled={running}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ExportBar({
  analysisId,
  selectedCode,
  disabled,
}: {
  analysisId: string | null;
  selectedCode: string | null;
  disabled: boolean;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exportDetermination() {
    if (!analysisId || !selectedCode) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/determinations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisId, selectedHtsCode: selectedCode, analystNote: note }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(payload?.error ?? "Could not record the determination.");
        return;
      }

      const { determinationId } = (await response.json()) as {
        determinationId: string;
      };
      window.open(`/api/determinations/${determinationId}/pdf`, "_blank");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <label
        htmlFor="analyst-note"
        className="block text-sm font-medium text-[var(--text-primary)]"
      >
        Analyst note <span className="font-normal text-[var(--text-muted)]">(optional)</span>
      </label>
      <p className="mt-0.5 text-xs text-[var(--text-muted)]">
        Worth filling in if you are overriding the model&rsquo;s pick — the
        reason belongs in the record, not in someone&rsquo;s memory.
      </p>
      <textarea
        id="analyst-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        className="mt-2 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
      />

      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={exportDetermination}
          disabled={disabled || busy || !selectedCode || !analysisId}
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {busy ? "Recording…" : "Record determination and export PDF"}
        </button>
        {selectedCode ? (
          <span className="text-xs text-[var(--text-muted)]">
            Selected <span className="hts-code">{selectedCode}</span>
          </span>
        ) : (
          <span className="text-xs text-[var(--text-muted)]">
            Select a code first.
          </span>
        )}
      </div>
    </div>
  );
}
