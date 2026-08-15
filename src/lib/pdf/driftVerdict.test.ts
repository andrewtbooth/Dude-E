/**
 * The integrity alarm has to be able to stay quiet.
 *
 * Every determination on an existing volume was hashed by the document as it
 * stood when it was signed. The release that rewrote half those sections moves
 * the bytes of all of them — so without this discrimination, opening any
 * historical determination once would have stamped it "this re-issues
 * differently from the document that was signed" on /history. An alarm that
 * fires on the entire history on day one is not evidence of anything, which is
 * exactly the state the input-freezing work was undertaken to escape.
 */

import { describe, expect, it } from "vitest";
import { driftVerdict } from "./driftVerdict";
import { DETERMINATION_TEMPLATE_VERSION } from "./DeterminationDoc";

const ISSUED = "a".repeat(64);
const RENDERED = "b".repeat(64);

describe("driftVerdict", () => {
  it("takes the first render as the baseline", () => {
    expect(
      driftVerdict({ pdfSha256: null, pdfTemplateVersion: null }, RENDERED),
    ).toEqual({ kind: "baseline" });
  });

  it("is quiet when the same document produces the same bytes", () => {
    expect(
      driftVerdict(
        { pdfSha256: ISSUED, pdfTemplateVersion: DETERMINATION_TEMPLATE_VERSION },
        ISSUED,
      ),
    ).toEqual({ kind: "matches" });
  });

  it("does not accuse a determination the template moved under", () => {
    // The case that would have flagged the whole history: recorded under
    // version 1, re-exported after a release that changed the document.
    expect(
      driftVerdict(
        { pdfSha256: ISSUED, pdfTemplateVersion: 1 },
        RENDERED,
        2,
      ),
    ).toEqual({ kind: "rerendered_under_new_document", issuedUnder: 1 });
  });

  it("treats an unrecorded template version the same way", () => {
    // Determinations recorded before the column existed. Their hash came from a
    // document this build no longer renders, so the comparison is meaningless
    // rather than damning — and guessing which it was would be worse.
    expect(
      driftVerdict({ pdfSha256: ISSUED, pdfTemplateVersion: null }, RENDERED),
    ).toEqual({ kind: "rerendered_under_new_document", issuedUnder: null });
  });

  it("still reports drift within one document version", () => {
    // The case the alarm exists for, and the reason none of the above may
    // simply suppress it: same document, different bytes, so an input that was
    // supposed to be frozen on the row was not.
    expect(
      driftVerdict(
        { pdfSha256: ISSUED, pdfTemplateVersion: DETERMINATION_TEMPLATE_VERSION },
        RENDERED,
      ),
    ).toEqual({ kind: "drifted" });
  });

  it("reports drift for a determination recorded under a newer document", () => {
    // A rollback puts an older build in front of newer rows. The versions
    // differ, so the check still cannot speak — it must not read "older
    // template than mine" as the only shape of a version mismatch.
    expect(
      driftVerdict({ pdfSha256: ISSUED, pdfTemplateVersion: 3 }, RENDERED, 2),
    ).toEqual({ kind: "rerendered_under_new_document", issuedUnder: 3 });
  });
});
