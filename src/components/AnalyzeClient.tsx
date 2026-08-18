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
  /**
   * A run that is still going on the server with nobody watching it.
   *
   * `dropped` is the connection failing under us; `stopped` is the analyst
   * choosing to stop watching. Both leave the run alive — the server does not
   * cancel on a lost consumer — so both need a way back to the result, but
   * they must not be described to the analyst in the same words.
   */
  const [detached, setDetached] = useState<{
    id: string;
    reason: "dropped" | "stopped" | "cancelled";
  } | null>(null);

  const [cancelling, setCancelling] = useState(false);

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
      setDetached(null);
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
              /**
               * Put the run in the address bar the moment it exists.
               *
               * Until this, /analyze held a run that had no URL. A reload, a
               * back gesture, or iOS reclaiming the tab while the screen was
               * off all landed on an empty form, with the analysis still going
               * on the server and no way to reach it but History. replaceState
               * rather than push: the empty form is not a place worth going
               * back to, and this must not add a history entry the back
               * gesture has to walk through.
               */
              window.history.replaceState(null, "", `/analyze/${event.analysisId}`);
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
        if (!settled && startedId) setDetached({ id: startedId, reason: "dropped" });
      } catch (caught) {
        if ((caught as Error).name !== "AbortError") {
          setError(
            caught instanceof Error
              ? caught.message
              : "The analysis could not be completed.",
          );
          // Same reasoning as above: a transport failure does not stop the run.
          if (startedId) setDetached({ id: startedId, reason: "dropped" });
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

  /**
   * Stop the run itself, on the server.
   *
   * The counterpart to `stopWatching`, and the reason it can now be honest.
   * Detaching from the stream used to abort the run as a side effect, so the
   * two intentions — "I do not want to watch this" and "I do not want to pay
   * for this" — were the same gesture and the analyst got whichever they had
   * not meant. This is the second one, said out loud.
   */
  async function cancelRun() {
    if (!analysisId) return;
    setCancelling(true);
    try {
      const response = await fetch(`/api/analyses/${analysisId}/cancel`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        cancelled?: boolean;
        message?: string;
        error?: string;
      } | null;

      if (!response.ok) {
        setError(payload?.error ?? "Could not stop the run.");
        return;
      }

      abortRef.current?.abort();
      setRunning(false);
      setEntries((prev) => [
        ...prev,
        {
          kind: "warning",
          text:
            payload?.cancelled === false
              ? (payload.message ?? "Nothing to stop.")
              : "Run stopped. You can start it again from this page.",
        },
      ]);
      setDetached({ id: analysisId, reason: "cancelled" });
    } catch {
      setError("Could not reach the server to stop the run.");
    } finally {
      setCancelling(false);
    }
  }

  /**
   * Detach from the stream. This is not a cancel, and it used to be one.
   *
   * Aborting the fetch closes this end of the pipe. That used to abort the run
   * too — the route handed `request.signal` to the model call, so disconnecting
   * killed the analysis — while this button told the analyst the opposite. The
   * run now holds its own controller, so the words below are finally true:
   * leaving costs the progress log, not the analysis.
   */
  /**
   * Clear the result and put the form back.
   *
   * Deliberately does not clear the input: "new analysis" most often means
   * re-running a near-identical description with one detail changed, and
   * making the analyst retype it on a phone to do that is the wrong default.
   */
  function startOver() {
    setRun(null);
    setEntries([]);
    setAnalysisId(null);
    setDetached(null);
    setError(null);
    // The address bar is still pointing at the finished run, because the
    // stream put it there. Leaving it would mean a reload of what looks like
    // a blank form silently reopens the previous analysis.
    window.history.replaceState(null, "", "/analyze");
  }

  function stopWatching() {
    abortRef.current?.abort();
    setRunning(false);
    setEntries((prev) => [
      ...prev,
      {
        kind: "warning",
        text: "Stopped watching. The run continues on the server.",
      },
    ]);
    if (analysisId) setDetached({ id: analysisId, reason: "stopped" });
  }

  // Once a run has landed the form has done its job, and on a phone it is the
  // single biggest thing standing between the analyst and the answer: mode
  // toggle, four-row textarea, hint and button come to most of a screen. It
  // collapses to a line naming what was classified, with a way back.
  const collapsedForm = run !== null && !running;

  return (
    <div className="space-y-6">
      {collapsedForm && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
          <span className="caption shrink-0">
            {mode === "PART_NUMBER" ? "Part number" : "Classified"}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-secondary)]">
            {input}
          </span>
          <button
            type="button"
            onClick={startOver}
            className="tap-target shrink-0 text-xs font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            New analysis
          </button>
        </div>
      )}

      <form
        onSubmit={submit}
        hidden={collapsedForm}
        className="space-y-3"
      >
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
                    ? "tap-target rounded px-3 text-sm font-medium text-[var(--text-primary)] bg-[var(--surface-1)] shadow-[var(--shadow-sm)]"
                    : "tap-target rounded px-3 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
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
              /**
               * A part number is not prose and a phone keyboard treats it as
               * prose by default: "1734-IB8S" comes back as "1734-ib8s" with a
               * capital on the first letter and a red squiggle, or autocorrected
               * into a word outright. The wrong characters here mean the model
               * researches a part that does not exist.
               *
               * A description is prose and wants the opposite.
               */
              autoCapitalize={mode === "PART_NUMBER" ? "characters" : "sentences"}
              autoCorrect={mode === "PART_NUMBER" ? "off" : "on"}
              spellCheck={mode !== "PART_NUMBER"}
              className="input-control w-full resize-y px-3 py-2.5 text-sm disabled:opacity-60"
            />
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={disabled || running || input.trim().length < 3}
            className="tap-target justify-center rounded-md bg-[var(--accent)] px-5 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {running ? "Analyzing…" : "Classify"}
          </button>
          {running && (
            <button
              type="button"
              onClick={stopWatching}
              className="tap-target rounded-md border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)]"
            >
              Stop watching
            </button>
          )}
          {/*
            Separated from "Stop watching" by more than a label, because the
            two used to be the same action wearing different words. This one
            costs the analyst the run; the other costs them the progress log.
            Danger-toned and second, so the cheap one is the easy one to hit.
          */}
          {running && analysisId && (
            <button
              type="button"
              onClick={() => void cancelRun()}
              disabled={cancelling}
              className="tap-target rounded-md border border-[var(--danger)] px-3 text-sm text-[var(--danger)] transition-colors hover:bg-[var(--danger-subtle)] disabled:opacity-60"
            >
              {cancelling ? "Stopping…" : "Cancel run"}
            </button>
          )}
          {running && (
            <span className="text-xs text-[var(--text-muted)]">
              A thorough run takes several minutes.
            </span>
          )}
        </div>

        {/*
          What to type, said after the box you type it in.
          Peer feedback: an analyst who has used this before is scanning for
          the field, and guidance placed above it is a paragraph between them
          and the control every single time. It still needs to be on the page
          — the part-number and description modes want genuinely different
          input — so it moves rather than going away, and stays wired to the
          textarea through aria-describedby so a screen reader reaches it at
          the field regardless of where it sits visually.
        */}
        <p
          id="product-input-hint"
          className="text-xs text-[var(--text-muted)]"
        >
          {activeMode.hint}
        </p>
      </form>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-[var(--danger)] bg-[var(--danger-subtle)] px-4 py-3"
        >
          <p className="text-sm text-[var(--danger)]">{error}</p>
        </div>
      )}

      {detached && !run && (
        <div
          role="status"
          className="rounded-lg border border-[var(--warn)] bg-[var(--warn-subtle)] px-4 py-3"
        >
          <p className="text-sm text-[var(--text-primary)]">
            {detached.reason === "cancelled"
              ? "You stopped this run."
              : detached.reason === "stopped"
                ? "You stopped watching this run."
                : "The connection to this run dropped before it finished reporting."}
          </p>
          {/*
            Three outcomes, and the middle one used to be described in the words
            of the first while behaving like it too. Detaching leaves the run
            alive; cancelling ends it. Saying "nothing has been lost" over a run
            the analyst just cancelled would be the same false reassurance in a
            new place.
          */}
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {detached.reason === "cancelled"
              ? "It will not finish and no result will be written. The analysis page keeps your answers and can start it again."
              : "The analysis kept running on the server. Nothing has been lost and nothing needs re-running — open it once it settles."}
          </p>
          <a
            href={`/analyze/${detached.id}`}
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
