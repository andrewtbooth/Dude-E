import { redirect } from "next/navigation";
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
      <main className="mx-auto max-w-6xl px-5 py-8">
        {!revision && <NoDataNotice />}
      </main>
    </div>
  );
}

function NoDataNotice() {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--warn-subtle)] p-5">
      <h2 className="text-sm font-semibold text-[var(--warn)]">
        No HTSUS snapshot loaded
      </h2>
      <p className="mt-1.5 max-w-prose text-sm text-[var(--text-secondary)]">
        Classification is unavailable until a tariff snapshot has been synced.
        Running an analysis without one would produce codes that cannot be
        verified against a published edition.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md bg-[var(--surface-1)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]">
        npm run sync:htsus
      </pre>
    </div>
  );
}
