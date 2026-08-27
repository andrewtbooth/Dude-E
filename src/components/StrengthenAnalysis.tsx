"use client";

import { useId, useState } from "react";
import type { Refinement } from "@/lib/agent/schema";

/**
 * Close the gaps the analysis named but did not stop for.
 *
 * The model keeps two lists. `clarifying_questions` are decisive — it sets
 * `needs_more_info`, refuses to recommend, and the app blocks recording until
 * they are answered. `info_that_would_raise_confidence` is the other one:
 * facts that would firm the call up without being load-bearing enough to stop
 * on.
 *
 * The second list was rendered read-only and appeared nowhere on the exported
 * determination. So an analyst could be shown three specific things that would
 * have strengthened the classification, with no way to supply any of them short
 * of retyping the whole description as a fresh analysis — and the signed
 * document said nothing about gaps the analysis had itself identified.
 *
 * Deliberately opt-in rather than a gate. Some of these are genuinely not worth
 * a second run of minutes and real money, and that is the analyst's call to
 * make with the list in front of them; a threshold would make it for them and
 * would make it badly, because the confidence number it would key off has never
 * been calibrated. What this offers is the choice, priced honestly.
 *
 * The items are prose, not structured questions, so each becomes a refinement
 * whose `question` is the item text verbatim. That is what a reader of the
 * determination needs to see anyway — the gap as the analysis phrased it,
 * beside what the analyst supplied.
 */
export function StrengthenAnalysis({
  items,
  busy,
  onSubmit,
}: {
  items: string[];
  busy: boolean;
  onSubmit: (refinements: Refinement[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const fieldId = useId();

  const supplied = items.filter((_, index) => (answers[index] ?? "").trim()).length;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // Only what was actually supplied. Unlike the decisive questions, an
    // untouched item here is not a declination — the analyst never undertook to
    // answer these, and recording a refusal they did not make would put words
    // in their mouth on the determination.
    const refinements: Refinement[] = items
      .map((item, index) => ({ item, answer: (answers[index] ?? "").trim() }))
      .filter((entry) => entry.answer)
      .map((entry) => ({
        questionId: `raise-confidence:${entry.item.slice(0, 60)}`,
        question: entry.item,
        answer: entry.answer,
      }));
    if (refinements.length > 0) onSubmit(refinements);
  }

  if (!open) {
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="tap-target rounded-md border border-[var(--info)] px-3 text-xs font-medium text-[var(--info)] transition-colors hover:bg-[var(--info-subtle)]"
        >
          Supply {items.length === 1 ? "this" : "these"} and re-run
        </button>
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">
          Optional. A re-run costs another few minutes and another run&rsquo;s
          spend; whatever you leave blank stays on the determination as an
          unresolved gap.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      {items.map((item, index) => (
        <div key={index}>
          <label htmlFor={`${fieldId}-${index}`} className="input-label text-xs">
            {item}
          </label>
          <input
            id={`${fieldId}-${index}`}
            value={answers[index] ?? ""}
            onChange={(event) =>
              setAnswers((prev) => ({ ...prev, [index]: event.target.value }))
            }
            placeholder="Leave blank to keep it on the record as unresolved"
            className="input-control mt-1 w-full px-3 py-2 text-sm"
          />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || supplied === 0}
          className="tap-target rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {busy ? "Re-running…" : "Re-run with what I supplied"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="tap-target rounded-md border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)]"
        >
          Never mind
        </button>
        <span className="text-xs text-[var(--text-muted)]">
          {supplied} of {items.length} supplied
        </span>
      </div>
    </form>
  );
}
