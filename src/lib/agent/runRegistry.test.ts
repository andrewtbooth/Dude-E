/**
 * Who can stop a run, and who cannot.
 *
 * The registry exists because the two were the same before: the run was driven
 * by `request.signal`, so the browser disconnecting cancelled it. Closing a tab
 * threw away a multi-minute, real-money analysis while the UI said the run
 * continued on the server. Now a run holds its own controller, the stream going
 * away does not touch it, and stopping is something a request has to ask for by
 * id.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { abortRun, isRunActive, registerRun, releaseRun } from "./runRegistry";

describe("runRegistry", () => {
  beforeEach(() => {
    // The map is module state shared across tests; clear whatever a previous
    // case left behind rather than depending on order.
    for (const id of ["a", "b"]) abortRun(id, "test cleanup");
  });

  it("hands back a signal that is not aborted by anything else", () => {
    const controller = registerRun("a");
    expect(controller.signal.aborted).toBe(false);
    expect(isRunActive("a")).toBe(true);
  });

  it("aborts the run a cancel names, and only that one", () => {
    const a = registerRun("a");
    const b = registerRun("b");

    expect(abortRun("a", "cancelled by the analyst")).toBe(true);

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(isRunActive("a")).toBe(false);
    expect(isRunActive("b")).toBe(true);
  });

  it("reports honestly when there is nothing here to abort", () => {
    // A restarted machine, or a second instance. Not an error: the caller
    // marks the row regardless, and a cancel that only worked when the
    // registry happened to be warm would be worse than none.
    expect(abortRun("never-started", "cancelled by the analyst")).toBe(false);
  });

  it("supersedes an older run for the same analysis", () => {
    // Answering a clarifying question re-runs the same row. Two runs writing
    // to one analysis is worse than losing the older one — and the older one
    // is by definition the round that has just been replaced.
    const first = registerRun("a");
    const second = registerRun("a");

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(isRunActive("a")).toBe(true);
  });

  it("does not let a superseded run release the slot of the one that replaced it", () => {
    // The finally-block of a slow, aborted run arrives after its replacement
    // has registered. Deleting blindly there would leave the live run
    // unreachable, and the next cancel would find nothing to abort.
    const first = registerRun("a");
    const second = registerRun("a");

    releaseRun("a", first);

    expect(isRunActive("a")).toBe(true);
    expect(abortRun("a", "cancelled by the analyst")).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it("releases the slot when the run that owns it finishes", () => {
    const controller = registerRun("a");
    releaseRun("a", controller);
    expect(isRunActive("a")).toBe(false);
  });
});
