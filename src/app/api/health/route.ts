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

export async function GET() {
  const revision = tryGetActiveRevision();

  if (!revision) {
    return NextResponse.json(
      {
        status: "degraded",
        reason: "No HTSUS snapshot. Classification is disabled until `npm run sync:htsus` runs.",
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
