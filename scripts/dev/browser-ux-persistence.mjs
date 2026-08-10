/**
 * Can a run survive the browser that started it?
 *
 * The route keeps a run alive when the consumer drops — deliberately, because
 * by then most of the money is already spent. What was missing was any way back
 * to it: /analyze held a run with no URL, so a reload landed on an empty form;
 * the saved view told the analyst to "reload in a minute"; and the only listing
 * was History, under a heading about work without a recorded decision.
 *
 * These checks are about recovery paths, so they deliberately break things: a
 * mid-run reload, and a RUNNING row inserted behind the app's back.
 */
import Database from "better-sqlite3";
import { chromium, devices } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3112";
const DB = process.env.UX_DB ?? "dev-ux.db";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
});
const context = await browser.newContext(devices["iPhone 13"]);
const page = await context.newPage();

let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.fill("#name", "Dana Okafor");
  await page.fill("#email", "dana.okafor@example.com");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/analyze", { timeout: 20000 });
  await page.waitForLoadState("networkidle");

  await page.fill("textarea", "stainless steel vacuum-insulated water bottle, 750ml");
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

  // --- the run gets an address as soon as it exists -------------------------
  await page.waitForFunction(() => /\/analyze\/[^/]+$/.test(location.pathname), {
    timeout: 30000,
  });
  const runUrl = page.url();
  check(true, "the URL becomes the run's the moment it starts", runUrl.split("/").pop());

  // --- a reload mid-run lands on the run, not an empty form -----------------
  // This is the locked phone, the reclaimed tab, the fat-thumbed refresh.
  await page.reload({ waitUntil: "domcontentloaded" });
  const stillThere = await page
    .getByText("stainless steel vacuum-insulated water bottle")
    .first()
    .isVisible()
    .catch(() => false);
  check(stillThere, "a reload mid-run reopens the run rather than a blank form");

  await page.waitForSelector("text=Candidate classifications", { timeout: 120000 });
  check(true, "and the result renders on the saved view");

  // --- starting over clears the address, or a reload reopens the old run ----
  await page.goto(`${BASE}/analyze`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  await page.fill("textarea", "a different product entirely");
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
  await page.waitForSelector("text=Candidate classifications", { timeout: 120000 });
  await page.locator('button:has-text("New analysis")').click();
  check(
    new URL(page.url()).pathname === "/analyze",
    "New analysis puts the address bar back",
    new URL(page.url()).pathname,
  );

  // --- a stranded run is offered on the page the analyst comes back to ------
  // Inserted directly: a run that is genuinely mid-flight cannot be produced
  // on demand from a cassette that replays in milliseconds.
  const db = new Database(DB);
  const analystId = db.prepare("select id from Analyst limit 1").get().id;
  db.prepare(
    `insert into Analysis
       (id, analystId, mode, input, status, model, effort, htsusRevision,
        appVersion, createdAt)
     values (?, ?, 'DESCRIPTION', ?, 'RUNNING', 'replay:test', 'n/a',
             '2026-hts-revision-15', '0.0.0-ux', ?)`,
  ).run("ux-inflight-run", analystId, "run the phone walked away from", Date.now());
  db.close();

  await page.goto(`${BASE}/analyze`, { waitUntil: "domcontentloaded" });
  const strip = page.locator('section[aria-label="Runs still in progress"]');
  check(await strip.isVisible(), "the analyze page offers the run still going");
  check(
    await strip.getByText("run the phone walked away from").isVisible(),
    "and names it, so the analyst can tell which one it is",
  );
  check(
    await strip.getByText("does not cancel them").isVisible(),
    "and says starting a new analysis will not cancel it",
  );

  // --- the saved view watches instead of asking the analyst to poll ---------
  await page.goto(`${BASE}/analyze/ux-inflight-run`, { waitUntil: "domcontentloaded" });
  check(
    await page.getByText("this page will update itself").isVisible(),
    "the running view watches rather than saying 'reload in a minute'",
  );
  check(
    (await page.getByText("Reload in a minute").count()) === 0,
    "and no longer asks the analyst to poll by hand",
  );

  // Flip it terminal behind the app's back; the watcher should notice.
  const db2 = new Database(DB);
  db2
    .prepare("update Analysis set status = 'FAILED', error = ? where id = ?")
    .run("stopped for the purposes of this check", "ux-inflight-run");
  db2.close();

  await page.waitForSelector("text=This analysis failed", { timeout: 30000 });
  check(true, "and refreshes itself when the run reaches a terminal state");
} catch (e) {
  console.log("  FAIL  " + String(e.message || e).split("\n")[0]);
  failures++;
} finally {
  await browser.close();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
