"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type FieldErrors = Partial<Record<"name" | "email", string>>;

export function SignInForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(null);

    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email }),
      });

      if (response.ok) {
        router.replace("/analyze");
        router.refresh();
        return;
      }

      const payload = (await response.json().catch(() => null)) as {
        errors?: FieldErrors;
        error?: string;
      } | null;

      if (payload?.errors) setErrors(payload.errors);
      else setFormError(payload?.error ?? "Sign-in failed. Please try again.");
    } catch {
      setFormError("Could not reach the server. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        id="name"
        label="Full name"
        hint="Appears as the analyst of record on every determination you export."
        value={name}
        onChange={setName}
        error={errors.name}
        autoComplete="name"
        placeholder="Dana Okafor"
      />
      <Field
        id="email"
        label="Work email"
        hint="Used to attribute your analyses in the audit history."
        value={email}
        onChange={setEmail}
        error={errors.email}
        autoComplete="email"
        type="email"
        placeholder="dana.okafor@company.com"
      />

      {formError && (
        <p
          role="alert"
          className="rounded-md bg-[var(--danger-subtle)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
      >
        {busy ? "Starting session…" : "Start analyzing"}
      </button>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  error,
  type = "text",
  autoComplete,
  placeholder,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
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
        value={value}
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
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
