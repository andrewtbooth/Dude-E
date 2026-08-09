import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Masthead } from "@/components/Masthead";
import { RunResult } from "@/components/RunResult";
import type { ClassificationRun } from "@/lib/agent/classify";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { tryGetActiveRevision } from "@/lib/hts/store";

export const dynamic = "force-dynamic";

/**
 * One saved analysis, re-opened.
 *
 * Every run was already persisted; there was simply no route that could show
 * one, which made a dropped connection unrecoverable in the UI and left the
 * unresolved-analyses list on the history page pointing nowhere. The result is
 * rendered through the same component the live page uses, so what an analyst
 * reads here is what they would have read while it streamed.
 *
 * Read-only with respect to the model: selecting a code and recording a
 * determination work, because those act on the stored run. Answering a
 * clarifying question does not, because that means running the analysis again.
 */
export default async function SavedAnalysisPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");

  const { id } = await params;
  const analysis = await prisma.analysis.findUnique({
    where: { id },
    include: { analyst: true, determinations: { orderBy: { decidedAt: "desc" } } },
  });

  if (!analysis) notFound();

  // Scoped to the owner, matching the refine route. An analysis is the
  // reasoning behind someone's signed determination; it is not a shared
  // document, and an id is not an access grant.
  if (analysis.analystId !== session.id) notFound();

  const revision = tryGetActiveRevision();
  const run = parseRun(analysis.resultJson);

  return (
    <div className="min-h-screen">
      <Masthead session={session} active="analyze" />

      <main className="mx-auto max-w-4xl space-y-6 px-5 py-8">
        <header>
          <Link
            href="/history"
            className="text-xs text-[var(--text-muted)] underline underline-offset-2"
          >
            ← History
          </Link>
          <h1 className="mt-2 text-lg font-semibold tracking-tight text-[var(--text-primary)]">
            {analysis.mode === "PART_NUMBER" ? "Part number" : "Product description"}
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{analysis.input}</p>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Run by {analysis.analyst.name} · {analysis.createdAt.toISOString()} ·{" "}
            {analysis.model}, {analysis.effort} effort · {analysis.htsusRevision}
          </p>
        </header>

        {analysis.determinations.length > 0 && (
          <section className="rounded-lg border border-[var(--ok)] bg-[var(--ok-subtle)] p-4">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              A determination has already been recorded from this analysis
            </h2>
            <ul className="mt-2 space-y-1">
              {analysis.determinations.map((determination) => (
                <li key={determination.id} className="text-xs text-[var(--text-secondary)]">
                  <span className="hts-code">{determination.selectedHtsCode}</span>{" "}
                  by {determination.analystName} on{" "}
                  {determination.decidedAt.toISOString()} ·{" "}
                  <a
                    href={`/api/determinations/${determination.id}/pdf`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] underline underline-offset-2"
                  >
                    PDF
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              Recording another would leave two signed conclusions for one piece
              of work. Re-issue the existing document unless the first decision
              was genuinely wrong.
            </p>
          </section>
        )}

        {analysis.status === "RUNNING" && (
          <div
            role="status"
            className="rounded-lg border border-[var(--warn)] bg-[var(--warn-subtle)] px-4 py-3 text-sm text-[var(--text-primary)]"
          >
            This analysis is still running. Reload in a minute — a full run takes
            several, and the result is written when it finishes.
          </div>
        )}

        {analysis.status === "FAILED" && (
          <div
            role="alert"
            className="rounded-lg border border-[var(--danger)] bg-[var(--danger-subtle)] px-4 py-3"
          >
            <p className="text-sm text-[var(--danger)]">This analysis failed.</p>
            {analysis.error && (
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                {analysis.error}
              </p>
            )}
          </div>
        )}

        {run ? (
          <RunResult
            run={run}
            analysisId={analysis.id}
            tariffRetrievedAt={
              revision ? new Date(revision.retrievedAt).toISOString().slice(0, 10) : null
            }
          />
        ) : (
          analysis.status !== "RUNNING" &&
          analysis.status !== "FAILED" && (
            <p className="text-sm text-[var(--text-secondary)]">
              No result was stored for this analysis.
            </p>
          )
        )}
      </main>
    </div>
  );
}

/**
 * The run as it was stored.
 *
 * Written by this app one schema version ago at the earliest, but a row that
 * cannot be parsed must not take the page down with it — the surrounding
 * provenance is still worth showing, and "no result was stored" is a more
 * useful answer than a 500.
 */
function parseRun(raw: string | null): ClassificationRun | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClassificationRun;
  } catch {
    return null;
  }
}
