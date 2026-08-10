import Link from "next/link";

/**
 * The app's two destinations, within thumb reach.
 *
 * On a phone held one-handed the reachable arc is the bottom third of the
 * screen; the top-left corner — where the masthead nav sat — is the furthest
 * point from the thumb on the device. Two links used dozens of times a day do
 * not belong there.
 *
 * Phones only. From `sm` up the pointer is a mouse or a tablet held in two
 * hands, the masthead nav is as reachable as anything else, and a fixed bar
 * would just eat vertical space.
 */
export function BottomNav({ active }: { active?: "analyze" | "history" }) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border)] bg-[var(--surface-1)]/95 backdrop-blur sm:hidden"
      // Cleared by the safe-area inset so the bar sits above the home
      // indicator rather than under it, where its lower half is untappable.
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-md">
        <Item href="/analyze" current={active === "analyze"} label="Analyze">
          {/* A magnifier over a document: this is where work is classified. */}
          <path d="M4 3h9l5 5v5" />
          <path d="M4 3v18h6" />
          <circle cx="16" cy="17" r="3.5" />
          <path d="m19 20 2.5 2.5" />
        </Item>
        <Item href="/history" current={active === "history"} label="History">
          {/* A stack of records. */}
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h10" />
        </Item>
      </ul>
    </nav>
  );
}

function Item({
  href,
  current,
  label,
  children,
}: {
  href: string;
  current: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex-1">
      <Link
        href={href}
        aria-current={current ? "page" : undefined}
        className={`flex min-h-14 flex-col items-center justify-center gap-0.5 ${
          current
            ? "text-[var(--accent)]"
            : "text-[var(--text-muted)] transition-colors active:text-[var(--text-primary)]"
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
          aria-hidden="true"
        >
          {children}
        </svg>
        <span className="caption text-[color:inherit]">{label}</span>
      </Link>
    </li>
  );
}
