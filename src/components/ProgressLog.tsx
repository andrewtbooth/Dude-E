"use client";

import { useEffect, useRef, useState } from "react";

/** How far off the bottom the analyst can be before auto-follow gives up. */
const FOLLOW_THRESHOLD_PX = 48;

export interface ProgressEntry {
  kind: "status" | "thinking" | "tool" | "warning";
  text: string;
  detail?: string;
}

/**
 * A max-effort run takes minutes. Showing what the model is actually doing —
 * which chapter's notes it is reading, which code it is verifying — is the
 * difference between "working" and "hung", and it also lets an analyst catch
 * a run that has gone down the wrong branch early.
 */
export function ProgressLog({
  entries,
  running,
}: {
  entries: ProgressEntry[];
  running: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  /**
   * Whether to keep following the newest entry.
   *
   * Held in a ref and updated from the analyst's own scrolling rather than
   * measured when a new entry lands. By the time the effect below runs, React
   * has already appended the entry and grown `scrollHeight`, so the distance
   * to the bottom is measured against a box that just got taller — one entry
   * taller than the threshold makes it look like the analyst scrolled away,
   * and following then stops for the rest of the run. Reading intent from the
   * scroll event instead means the box can grow by any amount without being
   * mistaken for the analyst moving.
   */
  const following = useRef(true);

  // Keep the log pinned to its newest entry by moving the box's own
  // scrollTop. `scrollIntoView` walks the whole ancestor chain, so on a phone
  // — where the log sits mid-page — every streamed entry dragged the document
  // out from under the analyst's thumb.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || !following.current) return;
    box.scrollTop = box.scrollHeight;
  }, [entries.length]);

  // Scrolling up to re-read an earlier tool call has to survive the next entry
  // arriving; scrolling back down has to resume following.
  function onScroll(event: React.UIEvent<HTMLDivElement>) {
    const box = event.currentTarget;
    following.current =
      box.scrollHeight - box.scrollTop - box.clientHeight <=
      FOLLOW_THRESHOLD_PX;
  }

  if (entries.length === 0 && !running) return null;

  // While the run is going the log is the whole point — it is the only
  // evidence the thing is alive. The moment it finishes it becomes history,
  // and leaving it expanded puts a screenful of completed steps between the
  // analyst and the answer they were waiting for. So it folds itself away,
  // and re-opens on request.
  const open = running || expanded;

  return (
    <section
      aria-label="Analysis progress"
      aria-busy={running}
      className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)]"
    >
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        {running && (
          <span
            className="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]"
            aria-hidden="true"
          />
        )}
        <h2 className="caption">{running ? "Working" : "Analysis log"}</h2>

        {!running && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="tap-target ml-auto text-xs font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            {expanded ? "Hide" : `Show ${entries.length} steps`}
          </button>
        )}
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        hidden={!open}
        className="scroll-region max-h-72 px-4 py-3"
      >
        <ol className="space-y-1.5">
          {entries.map((entry, index) => (
            <li
              key={index}
              className="flex gap-2.5 text-xs leading-relaxed"
            >
              <Marker kind={entry.kind} />
              <span
                className={
                  entry.kind === "warning"
                    ? "text-[var(--warn)]"
                    : entry.kind === "thinking"
                      ? "text-[var(--text-muted)] italic"
                      : "text-[var(--text-secondary)]"
                }
              >
                {entry.text}
                {entry.detail && (
                  <span className="ml-1.5 font-mono text-[var(--text-muted)]">
                    {entry.detail}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Marker({ kind }: { kind: ProgressEntry["kind"] }) {
  const label =
    kind === "tool"
      ? "→"
      : kind === "warning"
        ? "!"
        : kind === "thinking"
          ? "·"
          : "•";
  const color =
    kind === "warning"
      ? "text-[var(--warn)]"
      : kind === "tool"
        ? "text-[var(--accent)]"
        : "text-[var(--text-muted)]";

  return (
    <span className={`shrink-0 font-mono ${color}`} aria-hidden="true">
      {label}
    </span>
  );
}
