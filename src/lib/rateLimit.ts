/**
 * A fixed-window rate limiter for the expensive endpoint.
 *
 * ## Why this exists
 *
 * `/api/analyze` runs Claude Opus at `max` effort with a 40-iteration tool
 * loop. One request costs real money and holds a connection for minutes. On a
 * deployment with a public URL and no access gate — which is the trial
 * configuration — anyone who finds the address can spend the whole API budget
 * in a few minutes, and nothing else in the stack would stop them.
 *
 * ## What it is not
 *
 * This is a budget guard, not access control. It is per-process and in-memory,
 * so it resets on deploy and does not coordinate across instances. That is
 * adequate for a single-instance trial and inadequate for anything else; a
 * second instance doubles the effective limit. If this outlives the trial,
 * move it to a shared store and put real authentication in front.
 */

interface Window {
  count: number;
  /** Epoch ms when this window resets. */
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Drop expired windows so a long-lived process does not grow unbounded. */
function sweep(now: number): void {
  if (windows.size < 1000) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets, for a Retry-After header. */
  retryAfter: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = windows.get(key);
  const window =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + windowMs };

  window.count += 1;
  windows.set(key, window);

  const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
  return {
    ok: window.count <= limit,
    limit,
    remaining: Math.max(0, limit - window.count),
    retryAfter,
  };
}

/**
 * Best-effort client identity.
 *
 * Behind a platform proxy the socket address is the proxy, so the forwarded
 * header is the only signal available. It is spoofable — which is precisely
 * why this is described above as a budget guard rather than a control.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (
    request.headers.get("fly-client-ip") ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

/** Reset between tests. */
export function resetRateLimits(): void {
  windows.clear();
}
