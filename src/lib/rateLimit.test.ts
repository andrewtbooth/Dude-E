import { afterEach, describe, expect, it, vi } from "vitest";
import { clientKey, rateLimit, resetRateLimits } from "./rateLimit";

afterEach(() => {
  resetRateLimits();
  vi.useRealTimers();
});

describe("rateLimit", () => {
  it("allows up to the limit and then refuses", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(rateLimit("k", 3, 60_000).ok).toBe(true);
    }
    expect(rateLimit("k", 3, 60_000).ok).toBe(false);
  });

  it("counts each key separately", () => {
    expect(rateLimit("a", 1, 60_000).ok).toBe(true);
    expect(rateLimit("a", 1, 60_000).ok).toBe(false);
    // One analyst hitting the limit must not lock out everyone else.
    expect(rateLimit("b", 1, 60_000).ok).toBe(true);
  });

  it("reports what is left and when it resets", () => {
    const first = rateLimit("k", 2, 60_000);
    expect(first.remaining).toBe(1);
    expect(first.retryAfter).toBeGreaterThan(0);
    expect(rateLimit("k", 2, 60_000).remaining).toBe(0);
  });

  it("lets the window expire", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00Z"));
    expect(rateLimit("k", 1, 60_000).ok).toBe(true);
    expect(rateLimit("k", 1, 60_000).ok).toBe(false);

    vi.setSystemTime(new Date("2026-08-03T00:01:01Z"));
    expect(rateLimit("k", 1, 60_000).ok).toBe(true);
  });
});

describe("clientKey", () => {
  it("takes the original client from a forwarded chain", () => {
    // Behind a platform proxy the socket address is the proxy, so the first
    // entry is the closest thing to a client identity available.
    const request = new Request("https://example.test", {
      headers: { "x-forwarded-for": "203.0.113.9, 70.41.3.18" },
    });
    expect(clientKey(request)).toBe("203.0.113.9");
  });

  it("falls back to platform headers, then to a constant", () => {
    expect(
      clientKey(
        new Request("https://example.test", {
          headers: { "fly-client-ip": "198.51.100.4" },
        }),
      ),
    ).toBe("198.51.100.4");
    expect(clientKey(new Request("https://example.test"))).toBe("unknown");
  });
});
