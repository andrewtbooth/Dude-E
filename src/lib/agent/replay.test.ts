import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProgressEvent } from "./classify";
import {
  REPLAY_MODEL_PREFIX,
  readCassette,
  replayCassette,
  writeCassette,
} from "./replay";

const savedEnv = { ...process.env };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cassette-"));

afterEach(() => {
  process.env = { ...savedEnv };
});

function doneEvent(model = "claude-sonnet-5"): ProgressEvent {
  return {
    type: "done",
    run: {
      result: {
        status: "complete",
        htsus_revision: "2026 HTS Revision 15",
        summary: "A vacuum flask.",
        researched_product: null,
        clarifying_questions: [],
        candidates: [],
        recommended_hts_code: "9617.00.10.00",
        assumptions: [],
        info_that_would_raise_confidence: [],
      },
      verification: { verifiedCodes: [], rejectedCodes: [], corrections: [] },
      usage: {
        inputTokens: 12,
        cacheWriteTokens: 4252,
        cacheReadTokens: 92424,
        outputTokens: 2857,
      },
      model,
      effort: "low",
      htsusRevision: "2026 HTS Revision 15",
      durationMs: 61_000,
    },
  } as unknown as ProgressEvent;
}

async function collect(file: string): Promise<ProgressEvent[]> {
  const events: ProgressEvent[] = [];
  for await (const event of replayCassette(file, 0)) events.push(event);
  return events;
}

describe("cassette round trip", () => {
  it("replays the recorded events in order", async () => {
    const file = path.join(tmp, "roundtrip.json");
    const recorded: ProgressEvent[] = [
      { type: "status", message: "one" },
      { type: "tool_use", name: "hts_search", summary: "two" },
      doneEvent(),
    ];
    writeCassette(file, { mode: "DESCRIPTION", input: "x", refinements: 0 }, recorded);

    const replayed = await collect(file);
    expect(replayed.map((e) => e.type)).toEqual(["status", "tool_use", "done"]);
    expect(readCassette(file).input).toBe("x");
  });

  it("points at how to record one when the cassette is missing", () => {
    expect(() => readCassette(path.join(tmp, "nope.json"))).toThrow(
      /--record/,
    );
  });

  it("refuses a cassette written by a different schema", () => {
    const file = path.join(tmp, "future.json");
    fs.writeFileSync(file, JSON.stringify({ version: 2, events: [] }));
    expect(() => readCassette(file)).toThrow(/version 2.*Re-record/s);
  });
});

/**
 * The two guards that keep a replay from being mistaken for a classification.
 * A cassette is a fixture; a determination exported from one would put an
 * analyst's name and a signature block over reasoning no model produced for
 * that input, which is the single worst thing this application could emit.
 */
describe("guards", () => {
  it("stamps the run so any artifact built from it is self-identifying", async () => {
    const file = path.join(tmp, "stamp.json");
    writeCassette(file, { mode: "DESCRIPTION", input: "x", refinements: 0 }, [
      doneEvent("claude-opus-5"),
    ]);

    const [event] = await collect(file);
    expect(event.type).toBe("done");
    if (event.type !== "done") throw new Error("unreachable");
    expect(event.run.model).toBe(`${REPLAY_MODEL_PREFIX}claude-opus-5`);
  });

  it("does not double-stamp a cassette of a replay", async () => {
    const file = path.join(tmp, "double.json");
    writeCassette(file, { mode: "DESCRIPTION", input: "x", refinements: 0 }, [
      doneEvent(`${REPLAY_MODEL_PREFIX}claude-opus-5`),
    ]);

    const [event] = await collect(file);
    if (event.type !== "done") throw new Error("unreachable");
    expect(event.run.model).toBe(`${REPLAY_MODEL_PREFIX}claude-opus-5`);
  });

  it("refuses to replay in a production build", async () => {
    const file = path.join(tmp, "prod.json");
    writeCassette(file, { mode: "DESCRIPTION", input: "x", refinements: 0 }, [
      doneEvent(),
    ]);
    // NODE_ENV is typed readonly; a production build is exactly the condition
    // under test, so it is set through a widened view of the same object.
    (process.env as Record<string, string>).NODE_ENV = "production";

    await expect(collect(file)).rejects.toThrow(/disabled in production/);
  });
});
