import crypto from "node:crypto";
import { renderToBuffer } from "@react-pdf/renderer";
import type { Determination, Analysis } from "../../../prisma/generated/client";
import type { Candidate } from "../agent/schema";
import { DeterminationDoc } from "./DeterminationDoc";
import type { Chapter99ScreeningScope } from "../hts/store";
import { buildDeterminationView, parseRefinements, parseRun } from "./buildView";

/**
 * Render a determination to PDF bytes, from the row and nothing else.
 *
 * One function, two callers — recording and re-issue — and that is the whole
 * point. The hash on the row is supposed to mean "this document is the document
 * that was issued", and it can only mean that if the bytes are produced the same
 * way both times, from inputs that are all frozen.
 *
 * They were not. `chapter99Scope` was read from the live snapshot inside the
 * export route, so it was not merely un-frozen, it was un-frozen in only one of
 * the two places a document could be produced. And one of its counts is the
 * number of declarable lines in the schedule, which every revision moves — so
 * after any sync, every determination re-rendered to different bytes, the
 * mismatch branch fired on all of them, and the one case that mattered was
 * indistinguishable from the noise.
 */
export async function renderDetermination(
  determination: Determination & { analysis: Analysis },
): Promise<{ buffer: Buffer; sha256: string }> {
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
    chapter99Scope: parseChapter99Scope(determination.chapter99ScopeJson),
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
  return {
    buffer,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

/**
 * Null for a determination recorded before the scope was frozen.
 *
 * Deliberately not backfilled from the current snapshot. Those rows were
 * decided against an edition this deployment may no longer hold, and printing
 * today's coverage under yesterday's revision label is the exact defect this
 * column exists to close. The document already has an honest branch for a scope
 * it cannot establish, and that is the correct rendering here.
 */
function parseChapter99Scope(json: string | null): Chapter99ScreeningScope | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const scope = parsed as Partial<Chapter99ScreeningScope>;
    return typeof scope.declarableLines === "number" &&
      typeof scope.linesReachedByEither === "number"
      ? (scope as Chapter99ScreeningScope)
      : null;
  } catch {
    return null;
  }
}
