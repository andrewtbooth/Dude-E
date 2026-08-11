import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Just the status of one analysis, for a page waiting on a run it is not
 * streaming.
 *
 * A run takes minutes and outlives the connection that started it — the route
 * deliberately keeps going when the browser drops, so the result lands in the
 * database either way. What was missing was any way for a page to notice. The
 * saved-analysis view told the analyst to "reload in a minute", which is the
 * application asking a person to poll on its behalf, on a phone, for a run
 * whose finish time it knows and they do not.
 *
 * Deliberately tiny: a status string and nothing else. Polling the full
 * analysis would ship the entire result payload every few seconds to answer a
 * yes-or-no question, and the payload is the largest thing this app stores.
 * When the status turns terminal the client re-renders the page once and gets
 * the result through the normal path.
 *
 * Owner-scoped, matching the page and the refine route: an analysis is the
 * reasoning behind someone's signed determination, and an id is not an access
 * grant.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { id } = await params;
  const analysis = await prisma.analysis.findUnique({
    where: { id },
    select: { analystId: true, status: true, error: true },
  });

  // 404 rather than 403 for someone else's analysis: a 403 confirms the id
  // exists, which is the one bit of information the scoping is meant to
  // withhold.
  if (!analysis || analysis.analystId !== session.id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  return NextResponse.json(
    { status: analysis.status, error: analysis.error },
    // A status that changes the moment the run ends must never be served from
    // a cache, by the browser or by anything between.
    { headers: { "Cache-Control": "no-store" } },
  );
}
