import { formatDate } from "@/lib/format";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AnalyzeClient } from "@/components/AnalyzeClient";
import { BottomNav } from "@/components/BottomNav";
import { Masthead } from "@/components/Masthead";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { tryGetActiveRevision } from "@/lib/hts/store";

export const dynamic = "force-dynamic";

export default async function AnalyzePage() {
  const session = await getSession();
  if (!session) redirect("/");

  const revision = tryGetActiveRevision();

  /**
   * Runs this analyst started that nothing is watching any more.
   *
   * A run outlives the connection that started it on purpose, so a locked
   * phone or a reclaimed tab leaves work finishing on the server with the
   * analyst back at an empty form. History listed it, eventually, under
   * "analyses without a recorded decision" — which is the right place to find
   * it a day later and the wrong place to find it ninety seconds later.
   */
  const inFlight = await prisma.analysis.findMany({
    where: { analystId: session.id, status: "RUNNING" },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { id: true, input: true, mode: true, createdAt: true },
  });

  return (
    <div className="min-h-dvh">
      <Masthead session={session} active="analyze" />

      <main className="mx-auto max-w-4xl px-5 py-8 pb-[calc(3.5rem+env(safe-area-inset-bottom)+2rem)] sm:pb-8">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
          Classify a product
        </h1>
        <p className="mt-1 mb-6 max-w-prose text-sm text-[var(--text-secondary)]">
          {revision
            ? `Working against ${revision.revision}. Every determination you export is stamped with your name, the time, and this edition.`
            : "No tariff edition is loaded."}
        </p>

        {inFlight.length > 0 && <ResumeStrip runs={inFlight} />}

        {!revision && <NoDataNotice />}
        {revision?.warnings.length ? (
          <IncompleteSnapshotNotice
            revision={revision.revision}
            warnings={revision.warnings}
          />
        ) : null}

        <AnalyzeClient
          disabled={!revision}
          tariffRetrievedAt={
            revision ? formatDate(revision.retrievedAt) : null
          }
        />
      </main>

      <BottomNav active="analyze" />
    </div>
  );
}

function NoDataNotice() {
  return (
    <div className="mb-6 rounded-lg border border-[var(--danger)] bg-[var(--danger-subtle)] p-5">
      <h2 className="text-sm font-semibold text-[var(--danger)]">
        No HTSUS snapshot loaded
      </h2>
      <p className="mt-1.5 max-w-prose text-sm text-[var(--text-secondary)]">
        Classification is disabled. Running without a published edition to
        verify against would produce codes nobody can check, which is worse than
        producing nothing.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md bg-[var(--surface-1)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]">
        npm run sync:htsus
      </pre>
    </div>
  );
}

function IncompleteSnapshotNotice({
  revision,
  warnings,
}: {
  revision: string;
  warnings: string[];
}) {
  return (
    <details className="mb-6 rounded-lg border border-[var(--warn)] bg-[var(--warn-subtle)] p-4">
      <summary className="tap-target cursor-pointer text-sm font-medium text-[var(--warn)]">
        {revision} synced with {warnings.length} warning
        {warnings.length === 1 ? "" : "s"} — parts of the tariff may be missing
      </summary>
      <ul className="mt-2 space-y-1 text-xs text-[var(--text-secondary)]">
        {warnings.slice(0, 25).map((warning, index) => (
          <li key={index}>{warning}</li>
        ))}
        {warnings.length > 25 && (
          <li className="text-[var(--text-muted)]">
            …and {warnings.length - 25} more, in the snapshot manifest.
          </li>
        )}
      </ul>
    </details>
  );
}

/**
 * A way back into work that is still going.
 *
 * Not a warning — nothing has gone wrong. The run is doing exactly what it was
 * built to do, which is to survive the browser that started it. This is only
 * the door back to it, at the top of the page the analyst returns to.
 */
function ResumeStrip({
  runs,
}: {
  runs: { id: string; input: string; mode: string; createdAt: Date }[];
}) {
  return (
    <section
      aria-label="Runs still in progress"
      className="mb-6 rounded-lg border border-[var(--accent)] bg-[var(--accent-subtle)] px-4 py-3"
    >
      <h2 className="caption text-[var(--accent)]">
        {runs.length === 1 ? "A run is still going" : `${runs.length} runs still going`}
      </h2>
      <ul className="mt-1.5 space-y-1">
        {runs.map((run) => (
          <li key={run.id}>
            <Link
              href={`/analyze/${run.id}`}
              className="tap-target w-full justify-between gap-3 text-sm text-[var(--text-primary)]"
            >
              <span className="min-w-0 flex-1 truncate">
                {run.mode === "PART_NUMBER" ? "Part no. " : ""}
                {run.input}
              </span>
              <span className="shrink-0 text-xs font-medium text-[var(--accent)] underline underline-offset-2">
                Open
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">
        These finish on the server whether or not this page is open. Starting a
        new analysis below does not cancel them.
      </p>
    </section>
  );
}
