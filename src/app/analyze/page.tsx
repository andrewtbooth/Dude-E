import { formatDate } from "@/lib/format";
import { redirect } from "next/navigation";
import { AnalyzeClient } from "@/components/AnalyzeClient";
import { Masthead } from "@/components/Masthead";
import { getSession } from "@/lib/auth/session";
import { tryGetActiveRevision } from "@/lib/hts/store";

export default async function AnalyzePage() {
  const session = await getSession();
  if (!session) redirect("/");

  const revision = tryGetActiveRevision();

  return (
    <div className="min-h-screen">
      <Masthead session={session} active="analyze" />

      <main className="mx-auto max-w-4xl px-5 py-8">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
          Classify a product
        </h1>
        <p className="mt-1 mb-6 max-w-prose text-sm text-[var(--text-secondary)]">
          {revision
            ? `Working against ${revision.revision}. Every determination you export is stamped with your name, the time, and this edition.`
            : "No tariff edition is loaded."}
        </p>

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
      <summary className="cursor-pointer text-sm font-medium text-[var(--warn)]">
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
