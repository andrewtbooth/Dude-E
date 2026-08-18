/**
 * The runs in flight in this process, so one request can stop what another
 * started.
 *
 * Two things pull against each other here and the code used to resolve both
 * the same way, wrongly.
 *
 * A run must outlive the connection that started it. It takes minutes, costs
 * real money, and the browser can vanish at any point — a locked phone, a
 * backgrounded tab, a proxy giving up. The route said it was doing this and was
 * not: it handed `request.signal` to the model call, and Next aborts that
 * signal the moment the client disconnects. So closing the window cancelled the
 * analysis and threw away everything already paid for, while the code comments
 * and the button label both promised the opposite.
 *
 * But a run must also be stoppable. Once disconnecting no longer cancels, an
 * analyst who submits the wrong description has no way to stop the spend — and
 * the accidental cancel was quietly doing that job. Stopping has to become an
 * explicit act rather than a side effect of closing a tab.
 *
 * So the run gets its own controller, registered here under the analysis id.
 * The stream going away does not touch it; the cancel route reaches in and
 * aborts it by id.
 *
 * Scope is one process, deliberately. `fly.toml` keeps a single machine up and
 * does not stop it on idle, so in practice a run and its cancel request meet
 * here. Where they do not — a restarted machine, a second instance — the cancel
 * route still marks the row, and the analysis becomes resumable rather than
 * silently continuing to look alive. The registry is an optimisation on top of
 * that record, never the record itself.
 */

/**
 * Survives hot reload for the same reason the Prisma client does: dev-mode
 * re-evaluation would otherwise strand every in-flight run behind a fresh map,
 * and a cancel would report success while aborting nothing.
 */
const globalForRuns = globalThis as unknown as {
  activeRuns?: Map<string, AbortController>;
};

const activeRuns: Map<string, AbortController> =
  globalForRuns.activeRuns ?? new Map();

if (process.env.NODE_ENV !== "production") globalForRuns.activeRuns = activeRuns;

/** Claim the slot for an analysis, returning the signal its run should use. */
export function registerRun(analysisId: string): AbortController {
  // A re-run of the same analysis supersedes whatever was there. Two runs
  // writing to one row is worse than losing the older one, and the older one
  // is by definition the round the analyst has just replaced.
  activeRuns.get(analysisId)?.abort(new Error("superseded by a newer run"));

  const controller = new AbortController();
  activeRuns.set(analysisId, controller);
  return controller;
}

/**
 * Release the slot, but only if it still belongs to this run.
 *
 * Without the identity check a slow finally-block from a superseded run would
 * delete the *new* run's entry, and the next cancel would find nothing to
 * abort.
 */
export function releaseRun(analysisId: string, controller: AbortController): void {
  if (activeRuns.get(analysisId) === controller) activeRuns.delete(analysisId);
}

/**
 * Stop a run this process is driving. Returns whether one was found.
 *
 * `false` is not a failure — it means the run is not here, which the caller
 * handles by marking the row anyway. A cancel that only worked when the
 * registry happened to be warm would be worse than no cancel at all.
 */
export function abortRun(analysisId: string, reason: string): boolean {
  const controller = activeRuns.get(analysisId);
  if (!controller) return false;
  controller.abort(new Error(reason));
  activeRuns.delete(analysisId);
  return true;
}

/** Whether this process is currently driving a run for the analysis. */
export function isRunActive(analysisId: string): boolean {
  return activeRuns.has(analysisId);
}
