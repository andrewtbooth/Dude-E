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

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    throw error;
  }

  const { id } = await context.params;

  const determination = await prisma.determination.findUnique({
    where: { id },
    include: { analysis: true, analyst: true },
  });

  if (!determination) {
    return NextResponse.json(
      { error: "Determination not found." },
      { status: 404 },
    );
  }
  if (!determination.analysis.resultJson) {
    return NextResponse.json(
      { error: "The underlying analysis has no stored result." },
      { status: 409 },
    );
  }

  // Everything is read from the determination's own frozen copies rather than
  // recomputed: re-issuing a PDF months later must reproduce what was decided,
  // not what today's tariff or today's analyst name would say.
  const view = buildDeterminationView({
    determinationId: determination.id,
    analyst: {
      name: determination.analyst.name,
      email: determination.analyst.email,
    },
    decidedAt: determination.decidedAt,
    htsusRevision: determination.htsusRevision,
    scheduleBEdition: determination.scheduleBEdition,
    model: determination.model,
    effort: determination.effort,
    appVersion: determination.appVersion,
    analystNote: determination.analystNote,
    mode:
      determination.analysis.mode === "PART_NUMBER"
        ? "PART_NUMBER"
        : "DESCRIPTION",
    input: determination.analysis.input,
    refinements: parseRefinements(determination.analysis.refinementsJson),
    run: parseRun(determination.analysis.resultJson),
    selected: JSON.parse(determination.selectedCandidateJson) as Candidate,
    alternates: JSON.parse(determination.alternatesJson) as Candidate[],
  });

  const buffer = await renderToBuffer(<DeterminationDoc view={view} />);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  // Recorded so a circulated PDF can be tied back to this row.
  if (determination.pdfSha256 !== sha256) {
    await prisma.determination
      .update({ where: { id: determination.id }, data: { pdfSha256: sha256 } })
      .catch(() => {
        // Delivering the document matters more than recording its hash.
      });
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
