"use client";

import { useState } from "react";
import type { ClassificationRun } from "@/lib/agent/classify";
import type { Refinement } from "@/lib/agent/schema";
import { CandidateCard } from "./CandidateCard";
import { ClarifyingQuestions } from "./ClarifyingQuestions";
import { ResultSummary } from "./ResultSummary";
import { VerdictCard } from "./VerdictCard";

/**
 * Everything downstream of a finished run: the summary, any clarifying
 * questions, the candidate list, and the export bar.
 *
 * Shared by the live analysis page and the saved-analysis page rather than
 * copied into each. The two views must agree about which candidate is the
 * model's pick, when export is allowed, and what the record says — a second
 * rendering would drift, and the direction it drifts in is a determination
 * exported from a screen that disagreed with the one the analyst read.
 *
 * Answering a question means running the analysis again, so the two views
 * differ in *how* rather than in whether: the live page passes `onRefine` and
 * streams the re-run itself; the saved page passes `renderQuestions` and lets
 * its own watcher follow a run it does not consume. Neither is read-only, and
 * the saved page used to be — which stranded every run that asked a question
 * while nobody was watching.
 */
export function RunResult({
  run,
  analysisId,
  tariffRetrievedAt,
  busy = false,
  onRefine,
  questionsSlot,
}: {
  run: ClassificationRun;
  analysisId: string | null;
  /** Snapshot retrieval date, already formatted, for dating Chapter 99 duties. */
  tariffRetrievedAt: string | null;
  busy?: boolean;
  onRefine?: (refinements: Refinement[]) => void;
  /**
   * Replace the clarifying-question block wholesale.
   *
   * The saved-analysis view answers questions by starting a fresh run and
   * letting its own watcher follow it, rather than streaming here — so it
   * supplies the whole block, not just a submit handler. Without this the saved
   * view fell through to `ReadOnlyQuestions`, which told the analyst the work
   * happens on the analysis page while they were standing on it.
   *
   * An already-rendered node rather than a render function, because the caller
   * is a server component: React refuses to serialise a function across that
   * boundary, and the page 500s. An element crosses it fine.
   */
  questionsSlot?: React.ReactNode;
}) {
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  return (
    <>
      {/* The answer first, then the questions it raises, then the reasoning.
          The provenance and advisory blocks in ResultSummary are what an
          analyst checks before exporting; they are not what they came for. */}
      <VerdictCard
        run={run}
        selected={
          selectedCode !== null &&
          run.result.recommended_hts_code !== null &&
          selectedCode.replace(/\D/g, "") ===
            run.result.recommended_hts_code.replace(/\D/g, "")
        }
        onSelect={setSelectedCode}
      />

      {run.result.clarifying_questions.length > 0 &&
        (questionsSlot ? (
          questionsSlot
        ) : onRefine ? (
          <ClarifyingQuestions
            questions={run.result.clarifying_questions}
            busy={busy}
            onSubmit={onRefine}
          />
        ) : (
          <ReadOnlyQuestions run={run} />
        ))}

      <ResultSummary run={run} />

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
                tariffRetrievedAt={tariffRetrievedAt}
                recommendedCode={run.result.recommended_hts_code}
                reportingNumberNote={
                  run.verification.reportingNumberNotes?.find(
                    (note) =>
                      note.code.replace(/\D/g, "") ===
                      candidate.hts_code.replace(/\D/g, ""),
                  ) ?? null
                }
              />
            ))}
          </ul>

          <ExportBar
            analysisId={analysisId}
            selectedCode={selectedCode}
            disabled={busy}
            status={run.result.status}
          />
        </section>
      )}
    </>
  );
}

/**
 * The questions as they were asked, on a view that cannot answer them.
 *
 * Rendering the interactive form here would offer a control that silently does
 * nothing. Saying plainly where the work continues is the smaller surprise.
 */
function ReadOnlyQuestions({ run }: { run: ClassificationRun }) {
  return (
    <section className="rounded-lg border border-[var(--warn)] bg-[var(--warn-subtle)] p-4">
      <h2 className="text-sm font-semibold text-[var(--text-primary)]">
        This analysis is waiting on answers
      </h2>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">
        The model could not responsibly pick a code without these. Answering
        them re-runs the analysis, which happens on the analysis page.
      </p>
      <ul className="mt-3 space-y-2">
        {run.result.clarifying_questions.map((question) => (
          <li key={question.id} className="text-xs text-[var(--text-secondary)]">
            <span className="text-[var(--text-primary)]">{question.question}</span>
            <span className="block text-[var(--text-muted)]">
              {question.why_it_matters}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExportBar({
  analysisId,
  selectedCode,
  disabled,
  status,
}: {
  analysisId: string | null;
  selectedCode: string | null;
  disabled: boolean;
  /** The run's own status. Recording is refused server-side unless complete. */
  status: ClassificationRun["result"]["status"];
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);

  // The server refuses to record a determination for a run that ended in
  // `needs_more_info`, and it is right to: the model declined to conclude, and
  // a signed document saying otherwise is the worst artifact this app could
  // produce. Offering the button anyway and answering with a 409 teaches the
  // analyst that the export is flaky rather than that the analysis is unfinished.
  const recordable = status === "complete";

  async function exportDetermination() {
    if (!analysisId || !selectedCode || busy) return;
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

      // The PDF is offered as a link rather than opened from here. `window.open`
      // two awaits after the click is not a user gesture any more, so popup
      // blockers eat it — and the determination row has already been written by
      // then, so the analyst sees nothing happen and clicks again, minting a
      // second row for the same decision. The link is also what you want when
      // the document needs re-issuing later.
      setIssued(determinationId);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (!recordable) {
    return (
      <p className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4 text-xs text-[var(--text-secondary)]">
        No determination can be recorded from this analysis: the model returned
        <span className="text-[var(--text-primary)]"> needs more information</span>,
        so the candidates above are working notes rather than a conclusion.
      </p>
    );
  }

  return (
    <div className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <label
        htmlFor="analyst-note"
        className="block text-sm font-medium text-[var(--text-primary)]"
      >
        Analyst note <span className="font-normal text-[var(--text-muted)]">(optional)</span>
      </label>
      <textarea
        id="analyst-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        disabled={issued !== null}
        className="input-control mt-2 w-full resize-y px-3 py-2 text-sm disabled:opacity-60"
      />
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Worth filling in if you are overriding the model&rsquo;s pick — the
        reason belongs in the record, not in someone&rsquo;s memory.
      </p>

      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}

      {issued ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <a
            href={`/api/determinations/${issued}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="tap-target w-full justify-center rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] sm:w-auto"
          >
            Open the determination PDF
          </a>
          <span className="text-xs text-[var(--text-muted)]">
            Recorded as <span className="hts-code">{issued}</span>. It is in
            History, and the PDF can be re-issued from there.
          </span>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={exportDetermination}
            disabled={disabled || busy || !selectedCode || !analysisId}
            className="tap-target w-full justify-center rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50 sm:w-auto"
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
      )}
    </div>
  );
}
