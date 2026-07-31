import { redirect } from "next/navigation";
import { SignInForm } from "@/components/SignInForm";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getSession } from "@/lib/auth/session";
import { tryGetActiveRevision } from "@/lib/hts/store";

export default async function SplashPage() {
  if (await getSession()) redirect("/analyze");

  const revision = tryGetActiveRevision();

  return (
    <main className="flex min-h-screen flex-col">
      <div className="flex justify-end p-5">
        <ThemeToggle />
      </div>

      <div className="mx-auto flex w-full max-w-5xl flex-1 items-center px-5 pb-24">
        <div className="grid w-full gap-12 md:grid-cols-[1.1fr_1fr] md:items-center">
          {/* Left: what this is and why it asks who you are. */}
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-[var(--text-muted)]">
              Import Compliance
            </p>
            <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight text-[var(--text-primary)]">
              Tariff classification,
              <br />
              with the reasoning shown.
            </h1>
            <p className="mt-4 max-w-prose text-[var(--text-secondary)]">
              Enter a part number or a product description. An import compliance
              model works through the General Rules of Interpretation against the
              active HTSUS, proposes ranked 10&#8209;digit candidates with
              justification, and asks you for anything that would narrow the
              call. You choose the code; the app exports the determination.
            </p>

            <dl className="mt-8 space-y-3 border-l-2 border-[var(--border)] pl-4">
              <Provenance
                term="Who"
                detail="Your name and email are stamped on every determination you export."
              />
              <Provenance
                term="When"
                detail="Each analysis and decision is timestamped in the audit history."
              />
              <Provenance
                term="Which tariff"
                detail={
                  revision
                    ? `${revision.revision}, synced ${formatDate(revision.retrievedAt)}.`
                    : "No HTSUS snapshot synced yet — run the sync before analyzing."
                }
              />
            </dl>
          </div>

          {/* Right: the sign-in card. */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-[var(--shadow)]">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              Identify yourself
            </h2>
            <p className="mt-1 mb-5 text-sm text-[var(--text-secondary)]">
              A classification is only defensible if it says who made it. There
              is no password &mdash; this records the analyst of record.
            </p>

            <SignInForm />

            {!revision && (
              <p className="mt-5 rounded-md bg-[var(--warn-subtle)] px-3 py-2 text-xs text-[var(--warn)]">
                No HTSUS data is loaded. Run{" "}
                <code className="font-mono">npm run sync:htsus</code> before
                running an analysis.
              </p>
            )}
          </div>
        </div>
      </div>

      <footer className="border-t border-[var(--border)] px-5 py-4">
        <p className="mx-auto max-w-5xl text-xs text-[var(--text-muted)]">
          Advisory work product. Not a CBP binding ruling &mdash; for
          high&#8209;value or ambiguous goods, request one under 19 CFR Part 177.
        </p>
      </footer>
    </main>
  );
}

function Provenance({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="flex gap-3 text-sm">
      <dt className="w-24 shrink-0 font-medium text-[var(--text-primary)]">
        {term}
      </dt>
      <dd className="text-[var(--text-secondary)]">{detail}</dd>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
