"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Watch a run this page is not streaming, and refresh once it finishes.
 *
 * The saved-analysis view is what an analyst lands on after the stream is gone
 * — the phone locked, the tab was backgrounded, they opened the row from
 * History. The run itself is still going on the server, and the page used to
 * say "reload in a minute", which asks a person to poll on the application's
 * behalf for an event the application will know about first.
 *
 * Polls a status-only endpoint and calls `router.refresh()` exactly once, when
 * the status turns terminal. Refreshing on a timer instead would re-fetch the
 * whole page every few seconds and reset the analyst's scroll position while
 * they read.
 */

/** Slow enough not to be chatty, fast enough to feel like it noticed. */
const POLL_MS = 5_000;

/**
 * How long to keep asking. A run that has not finished in twenty minutes is
 * not going to be resolved by more polling — the machine may have restarted
 * mid-run, which leaves the row RUNNING with nothing left to write it. Better
 * to stop and say so than to poll a dead row until the battery is flat.
 */
const GIVE_UP_MS = 20 * 60 * 1000;

export function RunningWatcher({
  analysisId,
  startedAt,
}: {
  analysisId: string;
  /** ISO timestamp the run was created, for the give-up window. */
  startedAt: string;
}) {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const deadline = new Date(startedAt).getTime() + GIVE_UP_MS;

    async function poll() {
      if (cancelled) return;

      if (Date.now() > deadline) {
        setGaveUp(true);
        return;
      }

      try {
        const response = await fetch(
          `/api/analyses/${analysisId}/status`,
          { cache: "no-store" },
        );
        if (response.ok) {
          const { status } = (await response.json()) as { status: string };
          if (status !== "RUNNING") {
            // One refresh, then stop. The server component re-renders with the
            // stored result and this component unmounts with it.
            router.refresh();
            return;
          }
        }
      } catch {
        // A failed poll is not a failed run — the phone may have lost signal
        // in a lift. Keep trying until the deadline.
      }

      if (!cancelled) window.setTimeout(() => void poll(), POLL_MS);
    }

    const timer = window.setTimeout(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [analysisId, startedAt, router]);

  if (gaveUp) {
    return (
      <p className="mt-1.5 text-xs text-[var(--text-secondary)]">
        Still marked as running after twenty minutes, which is longer than a run
        takes. The machine may have restarted mid-analysis, which leaves the row
        this way with nothing left to finish it. Reload to check, or run it
        again.
      </p>
    );
  }

  return (
    <p className="mt-1.5 text-xs text-[var(--text-secondary)]">
      Watching for it to finish — this page will update itself. You can leave
      and come back; the run does not depend on this tab.
    </p>
  );
}
