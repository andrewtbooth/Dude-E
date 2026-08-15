import { NextResponse } from "next/server";
import { UnauthenticatedError, requireSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import {
  getChapter99ScreeningScope,
  lookupExact,
  tryGetActiveRevision,
} from "@/lib/hts/store";
import {
  findCandidate,
  parseRun,
  selectAlternates,
} from "@/lib/pdf/buildView";
import { DETERMINATION_TEMPLATE_VERSION } from "@/lib/pdf/DeterminationDoc";
import { renderDetermination } from "@/lib/pdf/renderDetermination";

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
    // Not "a declarable 10-digit line". Some classifiable lines are eight
    // digits — the Chapter 91 watch provisions, whose reporting numbers come
    // from a chapter statistical note — and telling an analyst their code is
    // not ten digits reasserts, at the moment of signature, exactly the
    // falsehood this application was corrected to stop printing. What is
    // actually wrong in this branch is that the snapshot does not offer the
    // code as the deepest line, which can equally mean the snapshot is stale.
    return NextResponse.json(
      {
        error:
          `${selected.hts_code} is not offered as a classifiable line by the ` +
          `tariff snapshot loaded now` +
          (activeRevision ? ` (${activeRevision.revision})` : "") +
          `. The snapshot may have moved since the analysis ran, or may predate ` +
          `a change in how lines are derived. Re-run the analysis against the ` +
          `current edition; if it recurs on a code you believe is valid, the ` +
          `snapshot needs re-syncing rather than the analysis re-running.`,
      },
      { status: 409 },
    );
  }

  // One analysis, one determination.
  //
  // Recording is not idempotent and the button that triggers it is reachable
  // more than once: a slow POST, an impatient second click, a retried request.
  // Every duplicate is a separately-numbered signed conclusion for a single
  // piece of work, each with its own id, timestamp and PDF hash — and nothing
  // downstream can tell which one was the decision. The unique index on
  // `analysisId` is what actually prevents that; this check exists to answer
  // with something an analyst can act on rather than a constraint violation.
  const existing = await prisma.determination.findUnique({
    where: { analysisId: analysis.id },
    select: { id: true, selectedHtsCode: true, decidedAt: true },
  });
  if (existing) {
    return NextResponse.json(
      {
        error:
          `A determination was already recorded for this analysis on ` +
          `${existing.decidedAt.toISOString()} (${existing.selectedHtsCode}). ` +
          `Re-issue that document rather than recording a second one.`,
        determinationId: existing.id,
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
      //
      // The *backfilled* run, not the raw stored string. `parseRun` fills in
      // fields the analysis predates, and one of them — where a code's
      // reporting number is published — is read from the tariff index. Storing
      // the raw string left that to be recomputed on every later read, against
      // whatever snapshot the deployment held then, so a re-issued document
      // could state the opposite of the one that circulated while still naming
      // the revision on this row. Reconstruct once, here, and freeze it.
      runJson: JSON.stringify(run),
      refinementsJson: analysis.refinementsJson,
      chapter99ScopeJson: JSON.stringify(getChapter99ScreeningScope()),
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
    include: { analysis: true },
  });

  // Hash the document now, not on first export.
  //
  // `pdfSha256` is the evidence that ties a circulated file back to this row,
  // and it was recorded whenever someone first asked for the PDF — which could
  // be weeks and a re-sync later. The baseline was therefore not the document
  // that was decided; it was whatever the document had become by the time
  // somebody looked. Anchoring it here is what makes a later mismatch mean
  // something.
  //
  // A failure to render must not cost the analyst their determination: the row
  // is the decision, the PDF is a view of it, and an unhashed row is a smaller
  // loss than a lost decision. The export route still records a hash for a row
  // that has none.
  try {
    const { sha256 } = await renderDetermination(determination);
    await prisma.determination.update({
      where: { id: determination.id },
      data: {
        pdfSha256: sha256,
        // Stamped alongside the hash, because the hash is only comparable
        // against a render of the same document.
        pdfTemplateVersion: DETERMINATION_TEMPLATE_VERSION,
      },
    });
  } catch (error) {
    console.error(
      `Determination ${determination.id} was recorded but could not be ` +
        `rendered for hashing: ${String(error)}`,
    );
  }

  return NextResponse.json({ determinationId: determination.id });
}
