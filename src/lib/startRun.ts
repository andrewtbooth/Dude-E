/**
 * Start a run on an existing analysis without holding its stream.
 *
 * The live page streams a run because it is showing the progress log. Every
 * other surface — answering a saved analysis's questions, resuming one that was
 * stopped — wants the run started and then wants to get on with rendering,
 * leaving `RunningWatcher` to notice when it lands.
 *
 * Releasing the response body is not abandoning the analysis. The route treats
 * a departed consumer as a reason to stop writing to the stream and nothing
 * more; the run holds its own abort controller and finishes into the database
 * either way. That is exactly the path a closed tab takes, which is the path
 * this whole area was rebuilt around.
 */
export async function startRunDetached(body: {
  analysisId: string;
  mode: "PART_NUMBER" | "DESCRIPTION";
  input: string;
  refinements?: { questionId: string; question: string; answer: string; declined?: boolean }[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refinements: [], ...body }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return { ok: false, error: payload?.error ?? `Request failed (${response.status}).` };
  }

  // The row is set RUNNING before the stream opens, so a 200 means the run is
  // under way and the page can re-render against it.
  await response.body?.cancel();
  return { ok: true };
}
