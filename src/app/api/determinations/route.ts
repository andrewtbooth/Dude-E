import { NextResponse } from "next/server";
import { UnauthenticatedError, requireSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { lookupExact, tryGetActiveRevision } from "@/lib/hts/store";
import {
  findCandidate,
  parseRun,
  selectAlternates,
} from "@/lib/pdf/buildView";

export const runtime = "nodejs";

/** Record the analyst's final call on an analysis. */
export async function POST(request: Request) {
  let session;
  try {
    session = await requireSession();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    throw error;
  }

  let body: {
    analysisId?: unknown;
    selectedHtsCode?: unknown;
    analystNote?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const analysisId =
    typeof body.analysisId === "string" ? body.analysisId : null;
  const selectedHtsCode =
    typeof body.selectedHtsCode === "string" ? body.selectedHtsCode.trim() : "";
  const analystNote =
    typeof body.analystNote === "string" && body.analystNote.trim()
      ? body.analystNote.trim().slice(0, 4000)
      : null;

  if (!analysisId || !selectedHtsCode) {
    return NextResponse.json(
      { error: "analysisId and selectedHtsCode are required." },
      { status: 400 },
    );
  }

  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
  });
  if (!analysis) {
    return NextResponse.json({ error: "Analysis not found." }, { status: 404 });
  }
  if (analysis.analystId !== session.id) {
    // A determination names its analyst. Letting one person record a decision
    // against another's analysis would put the wrong name on the artifact.
    return NextResponse.json(
      { error: "This analysis belongs to another analyst." },
      { status: 403 },
    );
  }
  if (!analysis.resultJson) {
    return NextResponse.json(
      { error: "That analysis has no result to record." },
      { status: 409 },
    );
  }

  if (analysis.status !== "COMPLETE") {
    // A run that asked for more information has not reached a conclusion.
    // Recording one anyway produces a signed determination for a question the
    // model explicitly declined to answer.
    return NextResponse.json(
      {
        error:
          `This analysis is ${analysis.status.toLowerCase().replace(/_/g, " ")}, ` +
          `not complete. Answer the outstanding questions and re-run before ` +
          `recording a determination.`,
      },
      { status: 409 },
    );
  }

  const run = parseRun(analysis.resultJson);
  const selected = findCandidate(run.result.candidates, selectedHtsCode);
  if (!selected) {
    return NextResponse.json(
      { error: "The selected code is not one of this analysis's candidates." },
      { status: 400 },
    );
  }

  // Re-verify at decision time rather than trusting the stored run. The tariff
  // snapshot could have been re-synced between analysis and decision, and a
  // determination must name a code that exists in the edition it is stamped
  // with.
  const activeRevision = tryGetActiveRevision();
  const line = lookupExact(selected.hts_code);
  if (!line || !line.isReportable) {
    return NextResponse.json(
      {
        error:
          `${selected.hts_code} is not a declarable 10-digit line in the ` +
          `current tariff snapshot. Re-run the analysis against the current edition.`,
      },
      { status: 409 },
    );
  }

  const determination = await prisma.determination.create({
    data: {
      analysisId: analysis.id,
      analystId: session.id,
      selectedHtsCode: selected.hts_code,
      selectedCandidateJson: JSON.stringify(selected),
      alternatesJson: JSON.stringify(
        selectAlternates(run.result.candidates, selected.hts_code),
      ),
      // Frozen copies — the analysis row they came from can still be re-run.
      runJson: analysis.resultJson,
      refinementsJson: analysis.refinementsJson,
      analystNote,
      // Frozen, not joined. The Analyst row keeps changing; this must not.
      analystName: session.name,
      analystEmail: session.email,
      htsusRevision: analysis.htsusRevision,
      tariffRetrievedAt: activeRevision?.retrievedAt ?? null,
      scheduleBEdition: analysis.scheduleBEdition,
      model: analysis.model,
      effort: analysis.effort,
      appVersion: analysis.appVersion,
    },
  });

  return NextResponse.json({ determinationId: determination.id });
}
