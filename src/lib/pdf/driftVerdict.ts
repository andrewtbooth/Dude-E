import { DETERMINATION_TEMPLATE_VERSION } from "./DeterminationDoc";

/**
 * What a re-render's hash means, given what the row recorded.
 *
 * `Determination.pdfSha256` alarms when a re-render disagrees with the hash
 * taken at decision time. Freezing every input made that alarm meaningful
 * against a *fixed* document — but the document is not fixed. Sections get
 * rewritten, and doing so changes the bytes of every determination ever
 * recorded. Undiscriminated, the first release to touch the template reports
 * the entire history as drifted on first re-export: the alarm firing on
 * everything at once, which is the same cries-wolf failure the freezing was
 * meant to end, arriving from the other direction.
 *
 * So the comparison is only valid within one template version. Across a
 * version boundary the check cannot speak, and saying so is the honest answer
 * — much better than an accusation the reader has no way to evaluate.
 *
 * Split out from the route because the route needs a session and a database
 * and this needs neither, and because getting it wrong is silent.
 */
export type DriftVerdict =
  /**
   * Recorded by a build that stamps the template version, but the
   * decision-time render did not complete. This render becomes the baseline.
   */
  | { kind: "baseline" }
  /**
   * Signed before this application hashed anything at decision time.
   *
   * There is no baseline to establish. Hashing the current render and storing
   * it as `pdfSha256` would record a document produced today — under a template
   * that did not exist when this was signed — as the bytes that were signed.
   * That is not a weak claim, it is a false one, and it is the same move as
   * reconstructing a reporting number from a snapshot that never saw it.
   */
  | { kind: "never_hashed" }
  /** Same document, same bytes. */
  | { kind: "matches" }
  /**
   * Different bytes, but a different document produced them. Expected, and
   * says nothing about this determination.
   */
  | { kind: "rerendered_under_new_document"; issuedUnder: number | null }
  /** Same document, different bytes. An input moved that should not have. */
  | { kind: "drifted" };

export function driftVerdict(
  stored: { pdfSha256: string | null; pdfTemplateVersion: number | null },
  renderedSha256: string,
  currentTemplateVersion: number = DETERMINATION_TEMPLATE_VERSION,
): DriftVerdict {
  if (stored.pdfSha256 === null) {
    // The template version is stamped when the row is created, before the
    // render is attempted, precisely so these two cases can be told apart: a
    // row this build made whose render failed, versus a row that predates
    // decision-time hashing altogether.
    return stored.pdfTemplateVersion === null
      ? { kind: "never_hashed" }
      : { kind: "baseline" };
  }
  if (stored.pdfSha256 === renderedSha256) return { kind: "matches" };
  if (stored.pdfTemplateVersion !== currentTemplateVersion) {
    return {
      kind: "rerendered_under_new_document",
      issuedUnder: stored.pdfTemplateVersion,
    };
  }
  return { kind: "drifted" };
}
