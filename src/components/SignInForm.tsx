"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { type SignInState, signInAction } from "@/app/actions/session";

const INITIAL: SignInState = {};

export function SignInForm() {
  const [state, formAction] = useActionState(signInAction, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Field
        id="name"
        label="Full name"
        hint="Appears as the analyst of record on every determination you export."
        error={state.errors?.name}
        autoComplete="name"
        placeholder="Dana Okafor"
      />
      <Field
        id="email"
        label="Work email"
        hint="Used to attribute your analyses in the audit history."
        error={state.errors?.email}
        autoComplete="email"
        type="email"
        placeholder="dana.okafor@company.com"
      />

      {state.formError && (
        <p
          role="alert"
          className="rounded-md bg-[var(--danger-subtle)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          {state.formError}
        </p>
      )}

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
    >
      {pending ? "Starting session…" : "Start analyzing"}
    </button>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  type = "text",
  autoComplete,
  placeholder,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div>
      <label
        htmlFor={id}
        className="block text-sm font-medium text-[var(--text-primary)]"
      >
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hintId}
        className="mt-1.5 w-full rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-[var(--danger)]">
          {error}
        </p>
      ) : (
        <p id={hintId} className="mt-1 text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      )}
    </div>
  );
}
