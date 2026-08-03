import { afterEach, describe, expect, it } from "vitest";
import { setupFixtureIndex, teardownFixtureIndex } from "@/test/htsus-fixture";
import { GET } from "./route";

afterEach(() => teardownFixtureIndex());

describe("GET /api/health", () => {
  it("reports the active snapshot and its age", async () => {
    setupFixtureIndex();
    const body = await (await GET()).json();
    expect(body.status).toMatch(/ok|degraded/);
    expect(body.snapshot.revision).toBe("2026 HTS Revision 13");
    expect(typeof body.snapshot.ageDays).toBe("number");
  });

  it("stays 200 with no snapshot rather than failing the check", async () => {
    // A deployment with no snapshot is behaving as designed — it refuses to
    // classify and says why. Failing the health check would put the platform
    // into a restart loop that cannot produce a snapshot.
    const previous = process.env.HTSUS_DATA_DIR;
    process.env.HTSUS_DATA_DIR = "/tmp/dude-e-no-such-snapshot";
    try {
      const response = await GET();
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.status).toBe("degraded");
      expect(body.snapshot).toBeNull();
      expect(body.reason).toMatch(/sync:htsus/);
    } finally {
      if (previous === undefined) delete process.env.HTSUS_DATA_DIR;
      else process.env.HTSUS_DATA_DIR = previous;
    }
  });

  it("flags a snapshot old enough to have been superseded", async () => {
    // Revisions ship every few weeks and staleness is otherwise silent.
    setupFixtureIndex();
    const body = await (await GET()).json();
    if (body.snapshot.ageDays >= 21) {
      expect(body.status).toBe("degraded");
      expect(body.reason).toMatch(/days old/);
    }
  });
});
