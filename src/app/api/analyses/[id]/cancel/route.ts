import { NextResponse } from "next/server";
import { abortRun } from "@/lib/agent/runRegistry";
import { sessionOrUnauthorized } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Stop a run, deliberately.
 *
 * This exists because stopping stopped happening by accident. The run used to
 * be tied to `request.signal`, so closing the tab cancelled it — which meant
 * "I do not want to watch this" and "I do not want to pay for this" were the
 * same gesture, and the analyst got whichever one they had not intended. A run
 * now survives its connection, so the second intention needs somewhere to live.
 *
 * The row is marked before the run is aborted, and that order is the point. The
 * mark is the record and the abort is an optimisation on top of it: if this
 * process is not the one driving the run — a restarted machine, a second
 * instance — there is nothing here to abort, and a cancel that silently did
 * nothing in that case would be worse than none at all. Marking regardless
 * leaves the analysis stopped, resumable, and honestly described.
 *
 * Scoped to a row that is still RUNNING, so cancelling a finished analysis
 * cannot discard a result that already landed.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await sessionOrUnauthorized();
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const analysis = await prisma.analysis.findUnique({
    where: { id },
    select: { analystId: true, status: true },
  });

  // 404 rather than 403 for someone else's analysis, matching the status and
  // refine routes: a 403 confirms the id exists, which is what scoping withholds.
  if (!analysis || analysis.analystId !== session.id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const stopped = await prisma.analysis.updateMany({
    where: { id, status: "RUNNING" },
    data: {
      status: "CANCELLED",
      error: null,
      completedAt: new Date(),
    },
  });

  if (stopped.count === 0) {
    // Already finished, already cancelled, or never started. Not an error —
    // the analyst asked for it to stop and it is stopped — but say which, so
    // the UI does not report a cancel that did nothing as if it had worked.
    return NextResponse.json({
      cancelled: false,
      status: analysis.status,
      message:
        analysis.status === "CANCELLED"
          ? "This run was already stopped."
          : "This run had already finished; nothing was cancelled.",
    });
  }

  const aborted = abortRun(id, "cancelled by the analyst");
  console.warn(
    `[analyze] ${id} cancelled by ${session.id}` +
      (aborted
        ? ""
        : " — no in-process run to abort; the row is marked and the analysis is resumable"),
  );

  return NextResponse.json({ cancelled: true, status: "CANCELLED", aborted });
}
