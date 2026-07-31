"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function SignOutButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await fetch("/api/session", { method: "DELETE" });
    startTransition(() => {
      router.replace("/");
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy || isPending}
      className="text-xs text-[var(--text-muted)] underline-offset-2 transition-colors hover:text-[var(--text-primary)] hover:underline disabled:opacity-50"
    >
      {busy || isPending ? "Signing out…" : "Sign out"}
    </button>
  );
}
