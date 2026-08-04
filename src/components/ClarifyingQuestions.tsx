"use client";

import { useState } from "react";
import type { ClarifyingQuestion, Refinement } from "@/lib/agent/schema";

/**
 * Questions the model needs answered before it can settle the classification.
 *
 * Answering is optional by design: an analyst who genuinely does not know the
 * material composition should be able to proceed on stated assumptions rather
 * than being blocked, so long as the resulting determination says so.
 */
export function ClarifyingQuestions({
  questions,
  onSubmit,
  busy,
}: {
  questions: ClarifyingQuestion[];
  onSubmit: (refinements: Refinement[]) => void;
  busy: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const answeredCount = questions.filter((q) =>
    (answers[q.id] ?? "").trim(),
  ).length;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const refinements: Refinement[] = questions
      .filter((question) => (answers[question.id] ?? "").trim())
      .map((question) => ({
        questionId: question.id,
        question: question.question,
        answer: answers[question.id].trim(),
      }));
    onSubmit(refinements);
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-[var(--info)] bg-[var(--info-subtle)] p-5"
    >
      <h2 className="text-sm font-semibold text-[var(--text-primary)]">
        These answers would settle the classification
      </h2>
      <p className="mt-1 max-w-prose text-sm text-[var(--text-secondary)]">
        Answer what you can. Anything you leave blank is carried into the
        determination as a stated assumption rather than a silent guess.
      </p>

      <ol className="mt-4 space-y-5">
        {questions.map((question, index) => (
          <li key={question.id}>
            <fieldset>
              <legend className="text-sm font-medium text-[var(--text-primary)]">
                {index + 1}. {question.question}
              </legend>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                {question.why_it_matters}
              </p>

              <div className="mt-2">
                {question.answer_type === "single_choice" &&
                question.options.length > 0 ? (
                  <ChoiceGroup
                    question={question}
                    value={answers[question.id] ?? ""}
                    onChange={(value) =>
                      setAnswers((prev) => ({ ...prev, [question.id]: value }))
                    }
                  />
                ) : (
                  <input
                    type={question.answer_type === "number" ? "number" : "text"}
                    value={answers[question.id] ?? ""}
                    onChange={(event) =>
                      setAnswers((prev) => ({
                        ...prev,
                        [question.id]: event.target.value,
                      }))
                    }
                    placeholder={
                      question.options.length > 0
                        ? question.options.join(", ")
                        : "Your answer"
                    }
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
                  />
                )}
              </div>
            </fieldset>
          </li>
        ))}
      </ol>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
        >
          {busy ? "Re-running…" : "Re-run with these answers"}
        </button>
        <span className="text-xs text-[var(--text-muted)]">
          {answeredCount} of {questions.length} answered
        </span>
      </div>
    </form>
  );
}

function ChoiceGroup({
  question,
  value,
  onChange,
}: {
  question: ClarifyingQuestion;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {question.options.map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? "" : option)}
            className={
              active
                ? "rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-text)]"
                : "rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)]"
            }
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}
