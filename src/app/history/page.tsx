import Link from "next/link";
import { redirect } from "next/navigation";
import { Masthead } from "@/components/Masthead";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; q?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");

  const { scope, q } = await searchParams;
  const mineOnly = scope !== "all";
  const query = (q ?? "").trim();

  const determinations = await prisma.determination.findMany({
    where: {
      ...(mineOnly ? { analystId: session.id } : {}),
      ...(query
        ? {
            OR: [
              { selectedHtsCode: { contains: query.replace(/\s/g, "") } },
              { analysis: { input: { contains: query } } },
            ],
          }
        : {}),
    },
    include: { analyst: true, analysis: true },
    orderBy: { decidedAt: "desc" },
    take: PAGE_SIZE,
  });

  const unresolved = await prisma.analysis.findMany({
    where: {
      ...(mineOnly ? { analystId: session.id } : {}),
      determinations: { none: {} },
      status: { in: ["COMPLETE", "NEEDS_MORE_INFO", "FAILED"] },
    },
    include: { analyst: true },
    orderBy: { createdAt: "desc" },
    take: 15,
  });

  return (
    <div className="min-h-screen">
      <Masthead session={session} active="history" />

      <main className="mx-auto max-w-6xl px-5 py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
              Determination history
            </h1>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              Every recorded decision, with the analyst and tariff edition it
              was stamped with. PDFs can be re-issued from here.
            </p>
          </div>

          <form className="flex flex-wrap items-center gap-2" action="/history">
            <input type="hidden" name="scope" value={mineOnly ? "mine" : "all"} />
            <input
              type="search"
              name="q"
              defaultValue={query}
              placeholder="HTS code or product"
              aria-label="Search determinations"
              className="w-56 rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)]"
            >
              Search
            </button>
          </form>
        </div>

        <nav className="mt-5 flex gap-1 border-b border-[var(--border)]">
          <ScopeTab href={`/history?scope=mine${query ? `&q=${encodeURIComponent(query)}` : ""}`} active={mineOnly}>
            Mine
          </ScopeTab>
          <ScopeTab href={`/history?scope=all${query ? `&q=${encodeURIComponent(query)}` : ""}`} active={!mineOnly}>
            Everyone
          </ScopeTab>
        </nav>

        {determinations.length === 0 ? (
          <EmptyState query={query} />
        ) : (
          <ul className="mt-5 space-y-2">
            {determinations.map((determination) => (
              <li
                key={determination.id}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4"
              >
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="hts-code text-base font-semibold text-[var(--text-primary)]">
                    {determination.selectedHtsCode}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {formatTimestamp(determination.decidedAt)}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {determination.analyst.name}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {determination.htsusRevision}
                  </span>

                  <a
                    href={`/api/determinations/${determination.id}/pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-subtle)]"
                  >
                    Open PDF
                  </a>
                </div>

                <p className="mt-2 line-clamp-2 text-sm text-[var(--text-secondary)]">
                  {determination.analysis.mode === "PART_NUMBER" && (
                    <span className="mr-1.5 rounded bg-[var(--surface-3)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                      Part no.
                    </span>
                  )}
                  {determination.analysis.input}
                </p>

                {determination.analystNote && (
                  <p className="mt-1.5 border-l-2 border-[var(--border-strong)] pl-2.5 text-xs text-[var(--text-muted)]">
                    {determination.analystNote}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {unresolved.length > 0 && (
          <section className="mt-10">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Analyses without a recorded decision
            </h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Work that was run but never concluded. Worth closing out or
              deliberately abandoning rather than leaving open.
            </p>
            <ul className="mt-3 space-y-1.5">
              {unresolved.map((analysis) => (
                <li key={analysis.id}>
                  {/* Linked, so "worth closing out" is something the analyst
                      can act on from here. Until /analyze/[id] existed this
                      list named work with no way to reach it. */}
                  <Link
                    href={`/analyze/${analysis.id}`}
                    className="flex flex-wrap items-baseline gap-x-3 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs transition-colors hover:border-[var(--accent)]"
                  >
                    <StatusTag status={analysis.status} />
                    <span className="text-[var(--text-muted)]">
                      {formatTimestamp(analysis.createdAt)}
                    </span>
                    <span className="text-[var(--text-muted)]">
                      {analysis.analyst.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
                      {analysis.input}
                    </span>
                    {analysis.error && (
                      <span className="text-[var(--danger)]">{analysis.error}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

function ScopeTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "-mb-px border-b-2 border-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--text-primary)]"
          : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      }
    >
      {children}
    </Link>
  );
}

function StatusTag({ status }: { status: string }) {
  const styles: Record<string, string> = {
    COMPLETE: "bg-[var(--ok-subtle)] text-[var(--ok)]",
    NEEDS_MORE_INFO: "bg-[var(--info-subtle)] text-[var(--info)]",
    FAILED: "bg-[var(--danger-subtle)] text-[var(--danger)]",
    RUNNING: "bg-[var(--surface-3)] text-[var(--text-muted)]",
  };
  const labels: Record<string, string> = {
    COMPLETE: "Complete",
    NEEDS_MORE_INFO: "Needs info",
    FAILED: "Failed",
    RUNNING: "Running",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-medium ${styles[status] ?? styles.RUNNING}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="mt-5 rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
      <p className="text-sm text-[var(--text-secondary)]">
        {query
          ? `No determinations match “${query}”.`
          : "No determinations recorded yet."}
      </p>
      <Link
        href="/analyze"
        className="mt-2 inline-block text-sm font-medium text-[var(--accent)] underline-offset-2 hover:underline"
      >
        Classify a product
      </Link>
    </div>
  );
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
