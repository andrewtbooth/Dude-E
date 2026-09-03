import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { DERIVATION_VERSION } from "@/lib/hts/parse";
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

  /**
   * Whether the snapshot was built by the rules this build holds.
   *
   * A snapshot is the USITC payload run through the parser with the results
   * *stored*, so a rule change ships inert until a sync runs again. The
   * entrypoint checks this and re-syncs in the background — which means there
   * is a window, right after a deploy, where the app is serving data derived by
   * the previous rules.
   *
   * The deploy workflow polls this endpoint and stops as soon as it says `ok`.
   * Without this field it said `ok` immediately, because the snapshot was
   * eleven days old against a twenty-one day threshold — so the run summary
   * announced "Deployment complete, tariff loaded" while the re-derive was
   * still going, or after it had failed outright. That is precisely the
   * silent-green failure DERIVATION_VERSION exists to prevent, relocated one
   * level up into the pipeline, and the release it hid turned entirely on
   * whether the re-derive had happened.
   */
  const derivationCurrent = revision.derivationVersion === DERIVATION_VERSION;

  // Both can be true at once, and for a while after a deploy they routinely
  // are: a snapshot old enough to want a newer revision *and* derived by rules
  // this build has moved past. Reporting only the first one sent an operator to
  // fix half the problem and then watch the endpoint stay degraded for a reason
  // it had never mentioned. The re-derive is listed first because it is the one
  // a deploy is actively waiting on.
  const reasons: string[] = [];
  if (!derivationCurrent) {
    reasons.push(
      `Snapshot was built by derivation ${revision.derivationVersion ?? "(unversioned)"}, ` +
        `this build is ${DERIVATION_VERSION}. A re-sync is running or has failed; ` +
        `until it lands, derived fields reflect the previous rules.`,
    );
  }
  if (stale) {
    reasons.push(
      `Snapshot is ${ageDays} days old. HTSUS revisions ship every few weeks; re-run the sync.`,
    );
  }
  const reason = reasons.length > 0 ? reasons.join(" ") : undefined;

  return NextResponse.json(
    {
      status: stale || !derivationCurrent ? "degraded" : "ok",
      reason,
      build,
      snapshot: {
        revision: revision.revision,
        scheduleBEdition: revision.scheduleBEdition,
        retrievedAt: revision.retrievedAt,
        ageDays,
        isPartial: revision.isPartial,
        warnings: revision.warnings.length,
        derivationVersion: revision.derivationVersion ?? null,
        derivationExpected: DERIVATION_VERSION,
        derivationCurrent,
      },
    },
    { status: 200 },
  );
}
