import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { tryGetActiveRevision } from "@/lib/hts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness and readiness for the platform's health check.
 *
 * Deliberately reports *degraded* rather than unhealthy when the tariff
 * snapshot is missing or stale. A deployment with no snapshot is still
 * correctly serving: it refuses to classify and says why, which is the
 * designed behaviour. Failing the health check there would put the platform
 * into a restart loop that cannot fix anything, since the fix is to run the
 * sync.
 *
 * Staleness is surfaced because nothing else does it unprompted. Revisions
 * ship every few weeks and a snapshot silently ages; an operator watching this
 * endpoint learns that before an analyst stamps a determination with a
 * superseded edition.
 */
const STALE_AFTER_DAYS = 21;

/**
 * Which build is actually serving.
 *
 * Next writes a fresh `BUILD_ID` for every compile, so this changes on each
 * deploy without needing a git SHA threaded through as a build argument —
 * which the platform's own web-UI deploy path does not provide. It exists
 * because "is my fix live yet?" was, repeatedly, unanswerable: a container
 * still running the previous image returns a byte-identical error to one where
 * the fix did not work, and the two call for opposite next steps.
 */
function buildId(): string | null {
  try {
    return fs
      .readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8")
      .trim();
  } catch {
    // Dev server, or a layout that puts the build elsewhere. Not worth failing
    // a health check over.
    return null;
  }
}

export async function GET() {
  const revision = tryGetActiveRevision();
  const build = buildId();

  if (!revision) {
    return NextResponse.json(
      {
        status: "degraded",
        reason: "No HTSUS snapshot. Classification is disabled until `npm run sync:htsus` runs.",
        build,
        snapshot: null,
      },
      // 200: the process is healthy and behaving as designed. Restarting it
      // would not produce a snapshot.
      { status: 200 },
    );
  }

  const ageMs = Date.now() - new Date(revision.retrievedAt).getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  const stale = ageDays >= STALE_AFTER_DAYS;

  return NextResponse.json(
    {
      status: stale ? "degraded" : "ok",
      reason: stale
        ? `Snapshot is ${ageDays} days old. HTSUS revisions ship every few weeks; re-run the sync.`
        : undefined,
      build,
      snapshot: {
        revision: revision.revision,
        scheduleBEdition: revision.scheduleBEdition,
        retrievedAt: revision.retrievedAt,
        ageDays,
        isPartial: revision.isPartial,
        warnings: revision.warnings.length,
      },
    },
    { status: 200 },
  );
}
