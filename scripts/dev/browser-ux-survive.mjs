/**
 * Does a run survive the browser going away, and does an explicit cancel stop it?
 *
 * These two were the same gesture. The route handed `request.signal` to the
 * model call, so disconnecting aborted the analysis — a closed tab threw away a
 * multi-minute, real-money run, and the "Stop watching" button did the same
 * thing while telling the analyst the run continued on the server. Nothing
 * offered a way back to a run that had been stopped either way.
 *
 * A unit test cannot see this. The abort comes from the platform tearing down a
 * request when a socket closes, which only happens to a real browser talking to
 * a real server.
 */
import { chromium, devices } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3112";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
});
const context = await browser.newContext(devices["iPhone 13"]);

let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

/**
 * Idempotent, because every page here shares one browser context and therefore
 * one session cookie. The second tab opens already signed in and the splash
 * redirects it straight to /analyze, where there is no name field to fill.
 */
async function signIn(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (!page.url().includes("/analyze")) {
    await page.fill("#name", "Dana Okafor");
    await page.fill("#email", "dana.okafor@example.com");
    await page.click('button[type="submit"]');
  }
  await page.waitForURL("**/analyze**", { timeout: 20000 });
}

async function startRun(page) {
  // A finished or in-flight run collapses the form; "New analysis" brings it
  // back. Harmless when it is not there.
  const fresh = page.getByRole("button", { name: "New analysis" });
  if (await fresh.isVisible().catch(() => false)) await fresh.click();
  await page.fill("textarea", "stainless steel vacuum-insulated water bottle");
  await page.waitForFunction(
    () => {
      const b = [...document.querySelectorAll("button")].find(
        (x) => x.textContent?.trim() === "Classify",
      );
      return b && !b.disabled;
    },
    { timeout: 20000 },
  );
  await page.click('button:has-text("Classify")');
  await page.waitForURL(/\/analyze\/[a-z0-9]+/i, { timeout: 30000 });
  return page.url().split("/").pop();
}

async function statusOf(page, id) {
  return page.evaluate(
    async (analysisId) =>
      (await (await fetch(`/api/analyses/${analysisId}/status`, { cache: "no-store" })).json())
        .status,
    id,
  );
}

try {
  // --- 1. a closed tab must not stop the run -------------------------------
  const page = await context.newPage();
  await signIn(page);
  const survivorId = await startRun(page);

  // Close the tab outright. This is the locked phone and the killed app: the
  // socket goes away with no chance to say anything about it.
  await page.close();

  const observer = await context.newPage();
  await signIn(observer);

  // Give the platform time to notice the disconnect and abort what it aborts.
  await observer.waitForTimeout(4000);
  let status = await statusOf(observer, survivorId);
  check(
    status === "RUNNING" || status === "COMPLETE" || status === "NEEDS_MORE_INFO",
    "closing the tab does not kill the run",
    `status=${status}`,
  );
  check(
    status !== "FAILED" && status !== "CANCELLED",
    "and the row is not marked failed or cancelled by the disconnect",
    `status=${status}`,
  );

  // It must also finish and record a result with nobody watching.
  for (let i = 0; i < 60 && status === "RUNNING"; i++) {
    await observer.waitForTimeout(1000);
    status = await statusOf(observer, survivorId);
  }
  check(
    status === "COMPLETE" || status === "NEEDS_MORE_INFO",
    "the abandoned run finishes and writes its result",
    `status=${status}`,
  );

  // --- 2. an explicit cancel must stop it ----------------------------------
  const canceller = await context.newPage();
  await signIn(canceller);
  const doomedId = await startRun(canceller);

  await canceller.click('button:has-text("Cancel run")');
  await canceller.waitForTimeout(1500);

  const cancelled = await statusOf(canceller, doomedId);
  check(cancelled === "CANCELLED", "an explicit cancel stops the run", `status=${cancelled}`);

  // --- 3. and a cancelled run offers a way back ----------------------------
  await canceller.goto(`${BASE}/analyze/${doomedId}`, { waitUntil: "domcontentloaded" });
  check(
    await canceller.getByText("You stopped this run").isVisible(),
    "the analysis page says the analyst stopped it",
  );
  check(
    await canceller.getByRole("button", { name: "Run this analysis again" }).isVisible(),
    "and offers to run it again on the same record",
  );

  await canceller.getByRole("button", { name: "Run this analysis again" }).click();
  await canceller.waitForTimeout(2500);
  const resumed = await statusOf(canceller, doomedId);
  check(
    resumed === "RUNNING" || resumed === "COMPLETE" || resumed === "NEEDS_MORE_INFO",
    "resuming starts a new run on the same analysis",
    `status=${resumed}`,
  );
} catch (e) {
  console.log("  FAIL  " + String(e.message || e).split("\n")[0]);
  failures++;
} finally {
  await browser.close();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
