import crypto from "node:crypto";
import { renderToBuffer } from "@react-pdf/renderer";
import { NextResponse } from "next/server";
import type { Candidate } from "@/lib/agent/schema";
import { UnauthenticatedError, requireSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { DeterminationDoc } from "@/lib/pdf/DeterminationDoc";
import {
  buildDeterminationView,
  parseRefinements,
  parseRun,
} from "@/lib/pdf/buildView";

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

  // Everything is read from the determination's own frozen copies rather than
  // recomputed: re-issuing a PDF months later must reproduce what was decided,
  // not what today's tariff or today's analyst name would say.
  const view = buildDeterminationView({
    determinationId: determination.id,
    analyst: {
      name: determination.analystName,
      email: determination.analystEmail,
    },
    decidedAt: determination.decidedAt,
    htsusRevision: determination.htsusRevision,
    scheduleBEdition: determination.scheduleBEdition,
    tariffRetrievedAt: determination.tariffRetrievedAt,
    model: determination.model,
    effort: determination.effort,
    appVersion: determination.appVersion,
    analystNote: determination.analystNote,
    mode:
      determination.analysis.mode === "PART_NUMBER"
        ? "PART_NUMBER"
        : "DESCRIPTION",
    input: determination.analysis.input,
    refinements: parseRefinements(determination.refinementsJson),
    run: parseRun(determination.runJson),
    selected: JSON.parse(determination.selectedCandidateJson) as Candidate,
    alternates: JSON.parse(determination.alternatesJson) as Candidate[],
  });

  const buffer = await renderToBuffer(<DeterminationDoc view={view} />);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  // Write-once. The hash exists so a PDF already in circulation can be tied
  // back to this row; overwriting it on a later re-issue would destroy exactly
  // the evidence it was recorded to preserve. Every input to the document is
  // frozen on the row, so a differing hash means something that should not
  // have changed did — surface it rather than quietly adopting the new value.
  if (determination.pdfSha256 === null) {
    await prisma.determination
      .update({ where: { id: determination.id }, data: { pdfSha256: sha256 } })
      .catch(() => {
        // Delivering the document matters more than recording its hash.
      });
  } else if (determination.pdfSha256 !== sha256) {
    console.error(
      `Determination ${determination.id} re-rendered to ${sha256} but was ` +
        `issued as ${determination.pdfSha256}. The stored hash is unchanged. ` +
        `Inputs are frozen on the row, so investigate before treating either ` +
        `document as authoritative.`,
    );
  }

  const filename = `determination-${determination.selectedHtsCode.replace(/\D/g, "")}-${determination.id}.pdf`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, no-store",
      "X-Determination-SHA256": sha256,
    },
  });
}
