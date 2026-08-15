import { NextResponse } from "next/server";
import { UnauthenticatedError, requireSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { DETERMINATION_TEMPLATE_VERSION } from "@/lib/pdf/DeterminationDoc";
import { driftVerdict } from "@/lib/pdf/driftVerdict";
import { renderDetermination } from "@/lib/pdf/renderDetermination";

export const runtime = "nodejs";

/**
 * Who may export someone else's determination.
 *
 * Team-wide by design, not by omission: `/history` deliberately offers an
 * org-wide tab so a colleague can review a decision, and review is the point
 * of a second pair of eyes. What matters is that the decision is made here,
 * explicitly and in one place, rather than being the accidental result of a
 * missing `where` clause.
 *
 * The real limit on this is that sign-in is self-asserted (see the README):
 * team-scope reads are only as strong as the identity behind them, which is
 * an argument for SSO, not for pretending an ownership filter would help.
 * Flip this to an owner-only check if determinations must not circulate
 * internally — the call site and the test both key off this function.
 */
function mayExport(
  _session: { id: string },
  _determination: { analystId: string },
): boolean {
  return true;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requireSession();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    throw error;
  }

  const { id } = await context.params;

  const determination = await prisma.determination.findUnique({
    where: { id },
    include: { analysis: true },
  });

  if (!determination) {
    return NextResponse.json(
      { error: "Determination not found." },
      { status: 404 },
    );
  }
  if (!mayExport(session, determination)) {
    // 404 rather than 403: a determination id is a customer's part number by
    // proxy, and confirming one exists tells an unauthorised caller something.
    return NextResponse.json(
      { error: "Determination not found." },
      { status: 404 },
    );
  }
  if (!determination.runJson) {
    return NextResponse.json(
      { error: "This determination has no frozen analysis to render." },
      { status: 409 },
    );
  }

  // Rendered by the same function that hashed it at decision time, from the
  // determination's own frozen copies. Re-issuing a PDF months later must
  // reproduce what was decided, not what today's tariff or today's analyst
  // name would say.
  const { buffer, sha256 } = await renderDetermination(determination);

  // Write-once. The hash exists so a PDF already in circulation can be tied
  // back to this row; overwriting it on a later re-issue would destroy exactly
  // the evidence it was recorded to preserve.
  //
  // A mismatch is now worth acting on, which it was not before: the scope
  // figures were read live, so every determination in the system drifted on
  // every weekly sync and this branch fired on all of them. With every input
  // frozen, a differing hash means something that should not have changed did.
  // So it is recorded on the row and shown on /history, rather than written to
  // a log line nobody tails — and the response says which hash is which,
  // instead of handing the caller the drifted one as though it were the issued
  // one.
  //
  // A hash can only be compared against a render of the same document, and the
  // document is not fixed — this release rewrote half its sections. Left
  // undiscriminated, the first such release would have reported every
  // determination ever recorded as drifted on its first re-export: the alarm
  // firing on the whole history at once, which is the cries-wolf failure the
  // freezing above was meant to end, arriving from the other direction.
  //
  // So a mismatch is only drift when both renders came from the same template.
  // A stored version that differs, or is absent because the determination
  // predates the column, means the bytes moved for a reason that has nothing to
  // do with this row — reported as a re-render, not as an alarm.
  const verdict = driftVerdict(determination, sha256);

  let drifted = determination.pdfSha256Drifted;

  if (verdict.kind === "baseline") {
    // This row was created by a build that hashes at decision time; the render
    // must have failed then. Recording it now is a late baseline for the same
    // document, which is honest.
    await prisma.determination
      .update({ where: { id: determination.id }, data: { pdfSha256: sha256 } })
      .catch(() => {
        // Delivering the document matters more than recording its hash.
      });
  } else if (verdict.kind === "never_hashed") {
    // Nothing is written. This determination was signed before the application
    // hashed anything at decision time, so there is no baseline to recover —
    // and storing today's render as `pdfSha256` would put a document produced
    // under a template that did not then exist on the record as the bytes that
    // were signed. Leaving the field null says "never hashed", which is true.
    console.info(
      `Determination ${determination.id} predates decision-time hashing; ` +
        `re-rendered to ${sha256} under document version ` +
        `${DETERMINATION_TEMPLATE_VERSION}. No baseline recorded, because the ` +
        `bytes that were signed are not recoverable.`,
    );
  } else if (verdict.kind === "rerendered_under_new_document") {
    console.info(
      `Determination ${determination.id} re-rendered to ${sha256} under ` +
        `document version ${DETERMINATION_TEMPLATE_VERSION}; it was issued as ` +
        `${determination.pdfSha256} under ` +
        `${verdict.issuedUnder ?? "an unrecorded version"}. The bytes differ ` +
        `because the document changed, not because this determination did. ` +
        `The issued hash is unchanged.`,
    );
  } else if (verdict.kind === "drifted") {
    drifted = sha256;
    await prisma.determination
      .update({
        where: { id: determination.id },
        data: { pdfSha256Drifted: sha256, pdfSha256DriftedAt: new Date() },
      })
      .catch(() => {});
    console.error(
      `Determination ${determination.id} re-rendered to ${sha256} but was ` +
        `issued as ${determination.pdfSha256} under the same document ` +
        `version. The stored hash is unchanged. Every input is frozen on the ` +
        `row, so investigate before treating either document as authoritative.`,
    );
  }

  const filename = `determination-${determination.selectedHtsCode.replace(/\D/g, "")}-${determination.id}.pdf`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, no-store",
      // The hash of *these* bytes, and separately the hash this determination
      // was issued under. A verifier that only ever saw the first header could
      // not tell a faithful re-issue from a drifted one, because a drifted
      // document reports its own hash just as confidently.
      "X-Determination-SHA256": sha256,
      ...(determination.pdfSha256
        ? { "X-Determination-Issued-SHA256": determination.pdfSha256 }
        : {}),
      ...(drifted ? { "X-Determination-Drifted": "true" } : {}),
      // Says which document produced these bytes, so a verifier holding an
      // older copy can tell "the template moved" from "this determination did"
      // without having to guess from a hash that differs either way.
      "X-Determination-Document-Version": String(
        DETERMINATION_TEMPLATE_VERSION,
      ),
      ...(verdict.kind === "rerendered_under_new_document"
        ? { "X-Determination-Rerendered-Under-New-Document": "true" }
        : {}),
    },
  });
}
