/**
 * Shared display formatting.
 *
 * `formatDate` lives here rather than in a page because the snapshot's
 * retrieval date now has to render in more than one place — the splash, the
 * analyze page's Chapter 99 caveat — and two copies would eventually disagree
 * about what a date looks like.
 */
export function formatDate(iso: string): string {
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
