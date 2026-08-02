"use client";

import { useId, useState } from "react";
import type { Candidate } from "@/lib/agent/schema";

export function CandidateCard({
  candidate,
  selected,
  onSelect,
}: {
  candidate: Candidate;
  selected: boolean;
  onSelect: () => void;
}) {
  const [showReasoning, setShowReasoning] = useState(false);
  const inputId = useId();
  const detailsId = `${inputId}-details`;

  return (
    <li
      className={
        selected
          ? "rounded-lg border-2 border-[var(--accent)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-sm)]"
          : "rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4"
      }
    >
      <div className="flex items-start gap-3">
        <input
          type="radio"
          id={inputId}
          name="selected-candidate"
          checked={selected}
          onChange={onSelect}
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
        />

        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="hts-code text-lg font-semibold text-[var(--text-primary)]">
              {candidate.hts_code}
            </span>
            <ConfidenceBadge value={candidate.confidence} />
            {candidate.rank === 1 && (
              <span className="rounded bg-[var(--accent-subtle)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--accent)]">
                Model&rsquo;s pick
              </span>
            )}
          </label>

          <Breadcrumb path={candidate.description_path} />

          <p className="mt-2.5 text-sm leading-relaxed text-[var(--text-secondary)]">
            {candidate.justification}
          </p>

          {candidate.why_not_selected && (
            <p className="mt-2 border-l-2 border-[var(--warn)] pl-3 text-sm text-[var(--text-secondary)]">
              <span className="font-medium text-[var(--warn)]">
                Why it loses:{" "}
              </span>
              {candidate.why_not_selected}
            </p>
          )}

          <DutyRow candidate={candidate} />

          {candidate.chapter_99.length > 0 && (
            <div className="mt-3 rounded-md bg-[var(--warn-subtle)] px-3 py-2">
              <p className="text-xs font-medium text-[var(--warn)]">
                Additional duties may apply
              </p>
              <ul className="mt-1 space-y-1">
                {candidate.chapter_99.map((entry) => (
                  <li
                    key={entry.hts_code}
                    className="text-xs text-[var(--text-secondary)]"
                  >
                    <span className="hts-code">{entry.hts_code}</span> ·{" "}
                    {entry.program} — {entry.additional_duty}
                    <span className="block text-[var(--text-muted)]">
                      {entry.applies_when}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowReasoning((open) => !open)}
            aria-expanded={showReasoning}
            aria-controls={detailsId}
            className="mt-3 text-xs font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            {showReasoning ? "Hide" : "Show"} GRI analysis
            {candidate.notes_applied.length > 0 &&
              `, notes (${candidate.notes_applied.length})`}
            {candidate.cross_rulings.length > 0 &&
              `, rulings (${candidate.cross_rulings.length})`}
          </button>

          {showReasoning && (
            <div id={detailsId} className="mt-3 space-y-4">
              <GriAnalysis candidate={candidate} />
              <NotesApplied candidate={candidate} />
              <CrossRulings candidate={candidate} />
              <ScheduleB candidate={candidate} />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function Breadcrumb({ path }: { path: string[] }) {
  if (path.length === 0) return null;
  return (
    <ol className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 text-xs text-[var(--text-muted)]">
      {path.map((segment, index) => (
        <li key={index} className="flex items-baseline gap-1.5">
          {index > 0 && <span aria-hidden="true">›</span>}
          <span
            className={
              index === path.length - 1
                ? "text-[var(--text-secondary)]"
                : undefined
            }
          >
            {segment.replace(/:$/, "")}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  const tone =
    pct >= 80
      ? "bg-[var(--ok-subtle)] text-[var(--ok)]"
      : pct >= 55
        ? "bg-[var(--warn-subtle)] text-[var(--warn)]"
        : "bg-[var(--danger-subtle)] text-[var(--danger)]";

  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
      title="The model's own confidence. Treat anything below 80% as needing a second look."
    >
      {pct}% confidence
    </span>
  );
}

function DutyRow({ candidate }: { candidate: Candidate }) {
  return (
    <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-xs">
      <Duty label="General" value={candidate.duty.general || "—"} />
      <Duty label="Special" value={candidate.duty.special || "—"} />
      <Duty label="Column 2" value={candidate.duty.column_2 || "—"} />
      <Duty
        label="Unit"
        value={candidate.unit_of_quantity.join(", ") || "—"}
      />
      {candidate.duty.rates_published_on && (
        <div className="basis-full text-[11px] text-[var(--text-muted)]">
          Rates published on{" "}
          <span className="hts-code">{candidate.duty.rates_published_on}</span>{" "}
          and inherited by this statistical line.
        </div>
      )}
    </dl>
  );
}

function Duty({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </dt>
      <dd className="text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}

const GRI_LABELS: [keyof Candidate["gri_analysis"], string][] = [
  ["gri_1", "GRI 1 — heading terms and relative notes"],
  ["gri_2", "GRI 2 — incomplete articles, mixtures"],
  ["gri_3", "GRI 3 — specificity, essential character, last in order"],
  ["gri_4", "GRI 4 — goods most akin"],
  ["gri_5", "GRI 5 — cases, containers, packing"],
  ["gri_6", "GRI 6 — subheading comparison"],
  ["additional_us_rules", "Additional U.S. Rules of Interpretation"],
];

function GriAnalysis({ candidate }: { candidate: Candidate }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        General Rules of Interpretation
      </h4>
      <dl className="mt-2 space-y-2.5">
        {GRI_LABELS.map(([key, label]) => {
          const value = candidate.gri_analysis[key];
          return (
            <div key={key}>
              <dt className="text-xs font-medium text-[var(--text-primary)]">
                {label}
              </dt>
              <dd
                className={
                  value
                    ? "text-xs leading-relaxed text-[var(--text-secondary)]"
                    : "text-xs italic text-[var(--text-muted)]"
                }
              >
                {value ?? "Not reached."}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function NotesApplied({ candidate }: { candidate: Candidate }) {
  if (candidate.notes_applied.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Section and Chapter notes relied on
      </h4>
      <ul className="mt-2 space-y-1.5">
        {candidate.notes_applied.map((note, index) => (
          <li key={index} className="text-xs text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">
              {note.reference}
            </span>{" "}
            — {note.effect}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CrossRulings({ candidate }: { candidate: Candidate }) {
  if (candidate.cross_rulings.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Prior CBP rulings
      </h4>
      <ul className="mt-2 space-y-2">
        {candidate.cross_rulings.map((ruling, index) => (
          <li key={index} className="text-xs text-[var(--text-secondary)]">
            <a
              href={ruling.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
            >
              {ruling.ruling_number}
            </a>
            <span className="block">{ruling.holding}</span>
            <span className="block text-[var(--text-muted)]">
              {ruling.relevance}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScheduleB({ candidate }: { candidate: Candidate }) {
  const scheduleB = candidate.schedule_b;

  // Absence is reported, not hidden. An analyst who sees nothing here cannot
  // tell "no export code was established" from "we forgot to look".
  if (!scheduleB) {
    return (
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Schedule B (export)
        </h4>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          No export code was established for this candidate.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Schedule B (export)
      </h4>
      <p className="mt-2 text-sm text-[var(--text-primary)]">
        <span className="hts-code">{scheduleB.code}</span> —{" "}
        {scheduleB.description}
      </p>
      {scheduleB.unit_of_quantity.length > 0 && (
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Export units: {scheduleB.unit_of_quantity.join(", ")}
        </p>
      )}
      <p className="mt-2 text-xs text-[var(--text-secondary)]">
        {scheduleB.justification}
      </p>
      {scheduleB.considered.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-[var(--text-muted)]">
            {scheduleB.considered.length} other export code
            {scheduleB.considered.length === 1 ? "" : "s"} under this subheading
          </summary>
          <ul className="mt-2 space-y-1">
            {scheduleB.considered.map((entry) => (
              <li key={entry.code} className="text-xs text-[var(--text-secondary)]">
                <span className="hts-code">{entry.code}</span> —{" "}
                {entry.description}
                <span className="text-[var(--text-muted)]">
                  {" "}
                  · {entry.why_not_selected}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
