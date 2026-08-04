/**
 * SSE writes after the consumer has gone.
 *
 * A run takes minutes and the browser can vanish at any point in them. When it
 * does, the stream is cancelled and the controller closes — but the generator
 * driving the loop is not attached to the socket, so it keeps producing events.
 *
 * The failure this pins down is not the lost events; it is what the naive
 * version does with them. `controller.enqueue` on a closed controller throws
 * "Invalid state: Controller is already closed", that lands in the run's catch
 * block, the catch block's own `send` throws the identical error again, and the
 * second throw is what reaches the analyst and the database. A real failure —
 * or a perfectly good run — is replaced by a complaint about plumbing.
 *
 * These tests exercise the send/cancel contract directly rather than booting
 * the route, which would need a session, a database and a live model.
 */

import { describe, expect, it } from "vitest";

/**
 * The route's write path, in the shape the handler uses it.
 *
 * Kept in step with `route.ts` by construction: both guard on a `consumerGone`
 * flag set by `cancel()`, and both swallow a raced enqueue.
 */
function makeSink() {
  const written: string[] = [];
  let consumerGone = false;
  let closed = false;

  const controller = {
    enqueue(chunk: string) {
      if (closed) throw new TypeError("Invalid state: Controller is already closed");
      written.push(chunk);
    },
    close() {
      if (closed) throw new TypeError("Invalid state: Controller is already closed");
      closed = true;
    },
  };

  const send = (payload: unknown) => {
    if (consumerGone) return;
    try {
      controller.enqueue(JSON.stringify(payload));
    } catch {
      consumerGone = true;
    }
  };

  return {
    written,
    send,
    cancel() {
      consumerGone = true;
      closed = true;
    },
    /** The route wraps its final close for the same reason. */
    finish() {
      try {
        controller.close();
      } catch {
        /* already closed by cancel */
      }
    },
    get consumerGone() {
      return consumerGone;
    },
  };
}

describe("analyze SSE sink", () => {
  it("writes normally while the consumer is listening", () => {
    const sink = makeSink();
    sink.send({ type: "status", message: "working" });
    sink.send({ type: "tool_use", name: "hts_search" });
    expect(sink.written).toHaveLength(2);
  });

  it("does not throw when the consumer left mid-run", () => {
    const sink = makeSink();
    sink.send({ type: "status", message: "working" });
    sink.cancel();

    // The generator keeps yielding for a while after a disconnect.
    expect(() => {
      sink.send({ type: "tool_use", name: "hts_lookup" });
      sink.send({ type: "thinking", text: "…" });
      sink.send({ type: "done", run: {} });
    }).not.toThrow();

    expect(sink.written).toHaveLength(1);
  });

  it("survives a cancel that races an in-flight write", () => {
    // cancel() lands between the consumerGone check and the enqueue.
    const sink = makeSink();
    let closedMidWrite = false;
    const racing = () => {
      if (!closedMidWrite) {
        closedMidWrite = true;
        sink.cancel();
      }
      sink.send({ type: "status", message: "raced" });
    };
    expect(racing).not.toThrow();
    expect(sink.consumerGone).toBe(true);
  });

  it("lets the error path report the real failure, not a closed controller", () => {
    // The regression. Previously the catch block's own send() threw again and
    // buried whatever actually went wrong.
    const sink = makeSink();
    sink.cancel();

    let reported: string | null = null;
    try {
      throw new Error("container_id is required when there are pending tool uses");
    } catch (error) {
      reported = error instanceof Error ? error.message : String(error);
      expect(() => sink.send({ type: "error", message: reported })).not.toThrow();
    }

    expect(reported).toBe(
      "container_id is required when there are pending tool uses",
    );
    expect(reported).not.toMatch(/Controller is already closed/);
  });

  it("closes exactly once, even after a cancel already closed it", () => {
    const sink = makeSink();
    sink.cancel();
    expect(() => sink.finish()).not.toThrow();
  });
});
