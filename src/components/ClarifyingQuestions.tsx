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
  /**
   * A multi-choice answer is held as the options picked, and joined only on
   * submit. A refinement carries one string, and joining on every toggle would
   * mean splitting it again to know what is selected — on a separator that
   * an option's own text could contain.
   */
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});

  const asText = (value: string | string[] | undefined): string =>
    (Array.isArray(value) ? value.join(", ") : (value ?? "")).trim();

  const answeredCount = questions.filter((q) => asText(answers[q.id])).length;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // Every question that was asked is submitted, answered or not. A blank is
    // not an absence of input — it is a senior analyst saying they cannot
    // establish this — and the copy above promises it will be carried into the
    // determination as a stated assumption. Dropping blanks here is where that
    // promise used to be broken, one line into its own implementation.
    const refinements: Refinement[] = questions.map((question) => {
      const answer = asText(answers[question.id]);
      return answer
        ? { questionId: question.id, question: question.question, answer }
        : {
            questionId: question.id,
            question: question.question,
            answer: "",
            declined: true,
          };
    });
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
                {(question.answer_type === "single_choice" ||
                  question.answer_type === "multi_choice") &&
                question.options.length > 0 ? (
                  <ChoiceGroup
                    question={question}
                    multiple={question.answer_type === "multi_choice"}
                    chosen={toArray(answers[question.id])}
                    onChange={(chosen) =>
                      setAnswers((prev) => ({
                        ...prev,
                        [question.id]:
                          question.answer_type === "multi_choice"
                            ? chosen
                            : (chosen[0] ?? ""),
                      }))
                    }
                  />
                ) : (
                  <input
                    type={question.answer_type === "number" ? "number" : "text"}
                    value={asText(answers[question.id])}
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
                    className="input-control w-full px-3 py-2 text-sm"
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

      {/*
        Below the questions, not above them. The analyst arrived here to answer
        something; the standing rule about blanks is what they need once they
        hit one they cannot answer, which is after they have read the question.

        And the promise is now kept. Every question is submitted whether or not
        it was answered, a blank travels as an explicit declination, and the
        re-run is told a human was asked and could not establish it — see
        Refinement and buildUserTurn. Until that landed this sentence was the
        one thing on the screen that was not true.
      */}
      <p className="mt-4 max-w-prose border-t border-[var(--info)]/30 pt-3 text-xs text-[var(--text-secondary)]">
        Answer what you can. Anything you leave blank is recorded as a question
        you were asked and could not settle: the re-run is told so, works from a
        stated assumption instead of a silent guess, and the determination says
        which.
      </p>
    </form>
  );
}

function toArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/**
 * The options as toggles. Single choice is exclusive; multi choice is not —
 * the schema offers both and the form used to render the second as a text
 * box with the options as a placeholder, which asked the analyst to retype
 * what they had just been shown.
 */
function ChoiceGroup({
  question,
  multiple,
  chosen,
  onChange,
}: {
  question: ClarifyingQuestion;
  multiple: boolean;
  chosen: string[];
  onChange: (chosen: string[]) => void;
}) {
  function toggle(option: string) {
    const active = chosen.includes(option);
    if (!multiple) return onChange(active ? [] : [option]);
    onChange(
      active ? chosen.filter((entry) => entry !== option) : [...chosen, option],
    );
  }

  return (
    <div
      role="group"
      aria-label={multiple ? "Choose all that apply" : "Choose one"}
      className="flex flex-wrap gap-2"
    >
      {question.options.map((option) => {
        const active = chosen.includes(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(option)}
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
