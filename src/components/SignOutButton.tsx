"use client";

import { useFormStatus } from "react-dom";
import { signOutAction } from "@/app/actions/session";

export function SignOutButton() {
  return (
    <form action={signOutAction}>
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
      className="text-xs text-[var(--text-muted)] underline-offset-2 transition-colors hover:text-[var(--text-primary)] hover:underline disabled:opacity-50"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
