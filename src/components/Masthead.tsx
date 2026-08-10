import Link from "next/link";
import type { AnalystSession } from "@/lib/auth/session";
import { tryGetActiveRevision } from "@/lib/hts/store";
import { SignOutButton } from "./SignOutButton";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The analyst's identity and the active HTSUS revision sit in the masthead on
 * every screen, because those two facts are what every artifact gets stamped
 * with. If either is wrong the analyst should notice before they export, not
 * after.
 */
export function Masthead({
  session,
  active,
}: {
  session: AnalystSession;
  active?: "analyze" | "history";
}) {
  const revision = tryGetActiveRevision();

  return (
    <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--surface-1)]/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
        <Link href="/analyze" className="flex items-baseline gap-2.5">
          {/* Set in the condensed face, uppercase and tracked, the way a form
              names its issuing authority in the top-left corner. */}
          <span className="font-[family-name:var(--font-display)] text-sm font-bold uppercase tracking-[0.14em] text-[var(--text-primary)]">
            Dude&#8209;E
          </span>
          <span className="caption hidden sm:inline">
            U.S. Tariff Classification
          </span>
        </Link>

        <nav className="flex items-center gap-1 text-sm">
          <NavLink href="/analyze" current={active === "analyze"}>
            Analyze
          </NavLink>
          <NavLink href="/history" current={active === "history"}>
            History
          </NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-4">
          <RevisionBadge
            revision={revision?.revision ?? null}
            scheduleBEdition={revision?.scheduleBEdition ?? null}
            warningCount={revision?.warnings.length ?? 0}
          />

          <div className="hidden text-right sm:block">
            <div className="text-xs font-medium text-[var(--text-primary)]">
              {session.name}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              {session.email}
            </div>
          </div>

          <SignOutButton />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function NavLink({
  href,
  current,
  children,
}: {
  href: string;
  current: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={
        current
          ? "rounded-md bg-[var(--surface-3)] px-2.5 py-1 text-[var(--text-primary)]"
          : "rounded-md px-2.5 py-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
      }
    >
      {children}
    </Link>
  );
}

function RevisionBadge({
  revision,
  scheduleBEdition,
  warningCount,
}: {
  revision: string | null;
  scheduleBEdition: string | null;
  warningCount: number;
}) {
  if (!revision) {
    return (
      <span
        className="stamp text-[var(--danger)]"
        title="No HTSUS snapshot has been synced. Run `npm run sync:htsus`. Analyses are unavailable until then."
      >
        No HTSUS data
      </span>
    );
  }

  // Both editions are named: the tariff and the export schedule version
  // independently of one another, and a determination stamps both.
  const editions = scheduleBEdition
    ? `${revision} · Schedule B ${scheduleBEdition}`
    : `${revision} · no Schedule B`;

  // The edition an analyst is about to stamp onto a determination is a field
  // on a form, not a status chip: it has a name and a value, and both matter.
  return (
    <span
      className={
        warningCount > 0
          ? "field border-[var(--warn)] bg-[var(--warn-subtle)] px-2 py-1"
          : "field px-2 py-1"
      }
      title={
        warningCount > 0
          ? `${editions} — synced with ${warningCount} warning(s). Parts of the tariff may be incomplete; see the manifest.`
          : scheduleBEdition
            ? `${editions} — the editions every determination from this session is stamped with.`
            : `${revision} — the edition every determination is stamped with. No export schedule was synced, so no Schedule B codes will be offered.`
      }
    >
      <span className="caption block">Tariff edition</span>
      <span
        className={`block text-[11px] font-medium ${
          warningCount > 0
            ? "text-[var(--warn)]"
            : "text-[var(--text-secondary)]"
        }`}
      >
        {editions}
        {warningCount > 0
          ? ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}`
          : ""}
      </span>
    </span>
  );
}
