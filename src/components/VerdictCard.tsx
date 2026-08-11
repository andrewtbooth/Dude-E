"use client";

import type { ClassificationRun } from "@/lib/agent/classify";
import type { Candidate } from "@/lib/agent/schema";
import { hasPublishedReportingNumber } from "@/lib/hts/parse";
import { HtsCode } from "./HtsCode";

/**
 * The answer, before anything else on the page.
 *
 * An analyst runs this to find out what to file. What they got instead was a
 * progress log, a provenance line, a summary paragraph, an assumptions block
 * and a confidence block — roughly a screen and a half on a phone — and only
 * then the code. The reasoning matters enormously and none of it is being
 * removed; it just does not come first. The order is now: what it is, what it
 * costs, then why.
 *
 * Three things this deliberately does not do:
 *
 * It does not select the code. Selection writes a determination under the
 * analyst's name, so it stays an explicit act — the button below says so, and
 * the candidate list remains the place it happens.
 *
 * It does not claim an answer the run did not reach. A `needs_more_info` run
 * gets a card that says there is no answer yet and points at the questions,
 * because a confident-looking card over an unfinished analysis is the worst
 * thing this screen could show.
 *
 * And it does not pass off the application's fallback as the model's
 * recommendation. When verification rejected the model's own pick, that is
 * said here, at the top, next to the code that replaced it.
 */
export function VerdictCard({
  run,
  onSelect,
  selected,
}: {
  run: ClassificationRun;
  /** Selects the recommended code in the candidate list below. */
  onSelect: (code: string) => void;
  selected: boolean;
}) {
  const { result, verification } = run;

  if (result.status !== "complete" || !result.recommended_hts_code) {
    return <NoVerdict run={run} />;
  }

  const recommended = result.candidates.find(
    (candidate) =>
      candidate.hts_code.replace(/\D/g, "") ===
      result.recommended_hts_code!.replace(/\D/g, ""),
  );
  if (!recommended) return <NoVerdict run={run} />;

  const substituted = verification.substitutedRecommendation;
  const chapter99 = recommended.tariff.chapter_99;

  return (
    <section
      aria-label="Recommended classification"
      className="overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-[var(--shadow-sm)]"
    >
      <div className="border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2">
        <span className="caption">
          {substituted ? "Best surviving candidate" : "Recommended classification"}
        </span>
      </div>

      <div className="px-4 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <HtsCode
            code={recommended.hts_code}
            size="lead"
            className="text-[var(--text-primary)]"
          />
          <span className={`stamp ${confidenceTone(recommended.confidence)}`}>
            <span className="hts-code font-semibold">
              {Math.round(Math.min(Math.max(recommended.confidence, 0), 1) * 100)}%
            </span>{" "}
            confidence
          </span>
        </div>

        {/* The heading text names the article; the segments below it qualify
            it. Showing only the last segment — which is what the deepest line
            says — gave "Having a capacity not exceeding 1 liter", a phrase
            that does not say what the thing is. */}
        <p className="mt-2 text-sm leading-snug text-[var(--text-primary)]">
          {stripColon(recommended.description_path[0] ?? "")}
        </p>
        {recommended.description_path.length > 1 && (
          <p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
            {recommended.description_path
              .slice(1)
              .map(stripColon)
              .join(" › ")}
          </p>
        )}

        <dl className="field-block mt-3.5 text-xs">
          <div className="field-grid">
            <div className="field">
              <dt className="caption">Duty (general)</dt>
              <dd className="field-value hts-code">
                {recommended.tariff.duty.general || "—"}
              </dd>
            </div>
            <div className="field">
              <dt className="caption">Unit</dt>
              <dd className="field-value hts-code">
                {recommended.tariff.unit_of_quantity.join(", ") || "—"}
              </dd>
            </div>
          </div>
        </dl>

        {substituted && (
          <p className="mt-3 border-l-2 border-[var(--danger)] pl-3 text-xs text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--danger)]">
              This is not the model&rsquo;s pick.{" "}
            </span>
            It recommended <span className="hts-code">{substituted.modelSaid}</span>,
            which is not in {result.htsus_revision}. The best candidate that did
            verify is shown instead — a run that invented a code is worth reading
            in full before you rely on it.
          </p>
        )}

        {!hasPublishedReportingNumber(recommended.hts_code) && (
          <p className="mt-3 border-l-2 border-[var(--warn)] pl-3 text-xs text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--warn)]">
              No ten-digit reporting number is published for this line.{" "}
            </span>
            The schedule stops here — no statistical breakout and no unit of
            quantity, where every other classifiable line in Chapters 1&ndash;97
            has both. It is the most specific classification available, but
            confirm the reporting number your broker should key before filing.
          </p>
        )}

        {chapter99.length > 0 && (
          <p className="mt-3 border-l-2 border-[var(--warn)] pl-3 text-xs text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--warn)]">
              Additional duties may apply.{" "}
            </span>
            {chapter99
              .map((entry) => `${entry.hts_code} (${entry.additional_duty})`)
              .join(", ")}
            . Details on the candidate below.
          </p>
        )}

        <button
          type="button"
          onClick={() => onSelect(recommended.hts_code)}
          aria-pressed={selected}
          className={
            selected
              ? "mt-4 min-h-11 w-full rounded-md border border-[var(--accent)] bg-[var(--accent-subtle)] px-4 text-sm font-medium text-[var(--accent)]"
              : "mt-4 min-h-11 w-full rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)]"
          }
        >
          {selected ? "Selected — record it below" : "Select this code"}
        </button>
        <p className="mt-1.5 text-center text-[11px] text-[var(--text-muted)]">
          Selecting does not record anything yet.
        </p>
      </div>
    </section>
  );
}

/**
 * What the top of the page says when there is no answer.
 *
 * The alternative — omitting the card and letting the summary lead again —
 * would mean the most important screen state is the one with no signpost at
 * all.
 */
function NoVerdict({ run }: { run: ClassificationRun }) {
  const questions = run.result.clarifying_questions.length;

  return (
    <section
      aria-label="Recommended classification"
      className="overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)]"
    >
      <div className="border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2">
        <span className="caption">No classification yet</span>
      </div>
      <div className="px-4 py-4">
        <p className="text-sm leading-snug text-[var(--text-primary)]">
          {questions > 0
            ? `The analysis stopped to ask ${questions} question${questions === 1 ? "" : "s"}.`
            : "This run did not reach a classification."}
        </p>
        <p className="mt-1.5 text-xs text-[var(--text-secondary)]">
          {questions > 0
            ? "Answering re-runs it with what you supply. Any candidates shown below are working notes, not a conclusion."
            : "No code verified against this tariff edition, so there is nothing to stand behind."}
        </p>
      </div>
    </section>
  );
}

/**
 * The schedule prints a trailing colon on any line that breaks out further.
 * That is correct in a tariff column and reads as a typo in a sentence.
 */
function stripColon(segment: string): string {
  return segment.replace(/:\s*$/, "");
}

/** Same bands as the candidate card — below 80% is worth a second look. */
function confidenceTone(value: number): string {
  const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  if (pct >= 80) return "text-[var(--ok)]";
  return pct >= 55 ? "text-[var(--warn)]" : "text-[var(--danger)]";
}

/** Exported for the candidate list, which needs the same notion of "the pick". */
export function isRecommended(
  candidate: Candidate,
  recommendedCode: string | null,
): boolean {
  if (!recommendedCode) return false;
  return (
    candidate.hts_code.replace(/\D/g, "") === recommendedCode.replace(/\D/g, "")
  );
}
