/**
 * Record one real classification, then replay it as many times as you like.
 *
 * Most of this application is not the model. Sign-in, the clarifying-question
 * loop, candidate selection, determination recording, the PDF, history, the
 * SSE transport and every guard in `verifyAgainstTariff` are ordinary software,
 * and all of them sit downstream of a `ClassificationRun`. Exercising them by
 * paying for a fresh multi-minute agent run each time is the expensive way to
 * test the cheap part of the system.
 *
 * A cassette is the event stream of a real run, captured verbatim. Replaying it
 * drives the identical code path — the route, the store, the renderer all see
 * what they saw the first time — for no API spend and in about a second.
 *
 * What it deliberately does not do is stand in for a model evaluation. A
 * cassette proves the plumbing carries a result; only a live run proves the
 * result is any good. The two guards below exist so nobody can confuse them:
 * replay refuses to load in a production build, and every run it yields is
 * stamped `replay:<model>` so any determination or PDF built from one says so
 * on its face, in the provenance block, permanently.
 */

import fs from "node:fs";
import path from "node:path";
import type { ProgressEvent } from "./classify";

/** Marks a run as replayed. Appears in the PDF provenance block verbatim. */
export const REPLAY_MODEL_PREFIX = "replay:";

interface Cassette {
  /** Schema marker, so an old cassette fails loudly rather than oddly. */
  version: 1;
  recordedAt: string;
  mode: string;
  input: string;
  /** Number of refinements the recorded run was given, for operator sanity. */
  refinements: number;
  events: ProgressEvent[];
}

export function isReplayableEnvironment(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Write a cassette.
 *
 * Cassettes hold whatever was classified, so they inherit that input's
 * sensitivity — a recorded part-number run contains the part number and
 * everything the web research turned up about it. `data/` is gitignored, which
 * is why cassettes live there and not beside the fixtures in `src/test`.
 */
export function writeCassette(
  file: string,
  meta: { mode: string; input: string; refinements: number },
  events: ProgressEvent[],
): void {
  const cassette: Cassette = {
    version: 1,
    recordedAt: new Date().toISOString(),
    ...meta,
    events,
  };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), JSON.stringify(cassette, null, 2));
}

export function readCassette(file: string): Cassette {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `No cassette at ${resolved}. Record one first:\n` +
        `  npx tsx scripts/dev/try-classify.ts --record ${file} "<product>"`,
    );
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as Cassette;
  if (parsed.version !== 1) {
    throw new Error(
      `Cassette ${resolved} is version ${parsed.version}; this build reads version 1. ` +
        `Re-record it.`,
    );
  }
  return parsed;
}

/**
 * Yield a recorded run's events.
 *
 * `stepDelayMs` exists because a replay that completes instantly does not
 * exercise what a real run does to the transport: the SSE consumer, the
 * progress log's buffering, and the "is this thing still alive" question a
 * multi-minute run raises are all timing behaviour. A small delay keeps replay
 * useful for testing the stream rather than only the final payload.
 */
export async function* replayCassette(
  file: string,
  stepDelayMs = 0,
): AsyncGenerator<ProgressEvent, void, undefined> {
  if (!isReplayableEnvironment()) {
    throw new Error(
      "Replay is disabled in production builds. A recorded run is a fixture, " +
        "not a classification, and an artifact exported from one would carry " +
        "an analyst's name over reasoning no model produced for that input.",
    );
  }

  const cassette = readCassette(file);

  for (const event of cassette.events) {
    if (stepDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    }

    if (event.type === "done") {
      // Stamped here rather than at record time so the cassette stays a
      // faithful copy of what the model returned, and so a cassette recorded
      // before this rule existed still cannot yield an unmarked run.
      const model = event.run.model.startsWith(REPLAY_MODEL_PREFIX)
        ? event.run.model
        : `${REPLAY_MODEL_PREFIX}${event.run.model}`;
      yield { ...event, run: { ...event.run, model } };
      continue;
    }
    yield event;
  }
}
