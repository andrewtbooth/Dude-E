"use client";

import { useEffect, useRef } from "react";

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
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length]);

  if (entries.length === 0 && !running) return null;

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
        <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">
          {running ? "Working" : "Analysis log"}
        </h2>
      </header>

      <div className="scroll-region max-h-72 px-4 py-3">
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
        <div ref={endRef} />
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
