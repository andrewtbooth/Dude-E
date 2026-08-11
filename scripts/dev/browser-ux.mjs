import Database from "better-sqlite3";
import { chromium, devices } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3112";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
});
// A real phone profile, not a narrow desktop window. The defects being checked
// here only appear when the page is taller than the viewport and the log sits
// below the fold, which is the mobile case and not the desktop one.
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

  // --- the button that used to lie ------------------------------------------
  await page.waitForSelector('button:has-text("Stop watching")', { timeout: 20000 });
  check(
    (await page.locator('button:has-text("Cancel")').count()) === 0,
    'no button claims to "Cancel" a run the server keeps running',
  );

  // --- the page must not move while the log streams -------------------------
  // Scroll the analyst somewhere deliberate, then let entries arrive. The old
  // implementation called scrollIntoView, which walks every scrollable
  // ancestor including the document, so each streamed entry yanked the page.
  await page.waitForSelector('section[aria-label="Analysis progress"]');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  // Sample both the window and the log box together, all the way through the
  // run. Checking only at the end would let a broken auto-scroll pass — the
  // log has to be shown to have actually overflowed and followed, not merely
  // to have sat still.
  const pageOffsets = [];
  const logSamples = [];
  const settled = page.waitForSelector("text=Candidate classifications", {
    timeout: 120000,
  });
  let done = false;
  void settled.then(() => {
    done = true;
  });

  while (!done) {
    const sample = await page.evaluate(() => {
      const box = document.querySelector(".scroll-region");
      return {
        windowY: window.scrollY,
        scrollable: box ? box.scrollHeight > box.clientHeight : false,
        distanceFromBottom: box
          ? box.scrollHeight - box.scrollTop - box.clientHeight
          : 0,
      };
    });
    pageOffsets.push(sample.windowY);
    logSamples.push(sample);
    await page.waitForTimeout(300);
  }
  await settled;

  const moved = Math.max(...pageOffsets) - Math.min(...pageOffsets);
  check(moved === 0, "page does not scroll while the log streams", `moved ${moved}px`);

  const overflowed = logSamples.filter((s) => s.scrollable);
  check(
    overflowed.length > 0,
    "the log actually overflowed its box during the run",
    `${overflowed.length}/${logSamples.length} samples`,
  );
  const trailing = overflowed.filter((s) => s.distanceFromBottom > 48);
  check(
    overflowed.length > 0 && trailing.length === 0,
    "the log box stayed pinned to its newest entry",
    `${trailing.length} sample(s) left behind`,
  );

  // --- punctuation must not wear the warning banner -------------------------
  // Every correction in this cassette is a description the model quoted with a
  // leading tariff number or without the trailing colon. That is not something
  // to warn an analyst about in the same words used for a wrong duty rate.
  const warnBanner = await page
    .getByText("These values were replaced with what the published schedule")
    .count();
  const disclosure = await page.locator("details summary").filter({
    hasText: /wording difference/,
  }).count();

  check(
    warnBanner === 0,
    "no corrections warning for punctuation-only differences",
  );
  check(
    disclosure === 1,
    "wording differences are still disclosed, just folded away",
    `saw ${disclosure}`,
  );

  if (disclosure === 1) {
    await page.locator("details summary").filter({ hasText: /wording difference/ }).click();
    check(
      await page.getByText("The published wording is what is shown").isVisible(),
      "the disclosure opens and explains what was normalised",
    );
  }

  // --- the answer has to be on the first screen -----------------------------
  // The point of the verdict card is measured in pixels from the top of the
  // document, not in whether it rendered. Asserting it exists somewhere would
  // pass with it below the fold, which is the state it was built to fix.
  const verdict = page.locator('section[aria-label="Recommended classification"]');
  check(await verdict.isVisible(), "a verdict card is shown");

  const geometry = await page.evaluate(() => {
    const card = document.querySelector(
      'section[aria-label="Recommended classification"]',
    );
    const log = document.querySelector('section[aria-label="Analysis progress"]');
    if (!card) return null;
    return {
      cardTop: card.getBoundingClientRect().top + window.scrollY,
      logTop: log ? log.getBoundingClientRect().top + window.scrollY : null,
      viewport: window.innerHeight,
    };
  });
  check(
    geometry !== null && geometry.cardTop < geometry.viewport,
    "the verdict is above the fold without scrolling",
    JSON.stringify(geometry),
  );

  // The log must fold once the run ends, or it reoccupies the space the card
  // was meant to claim.
  const logBody = await page.evaluate(() => {
    const log = document.querySelector('section[aria-label="Analysis progress"]');
    const box = log?.querySelector(".scroll-region");
    return box ? !box.hasAttribute("hidden") : null;
  });
  check(logBody === false, "the finished log folds itself away");

  // Selecting from the card must move the selection in the list below — and
  // must not be a pre-selection, which is why it takes a click at all.
  const before = await page.locator('input[type="radio"]:checked').count();
  check(before === 0, "nothing is selected until the analyst acts");

  await page.locator('button:has-text("Select this code")').click();
  const after = await page.locator('input[type="radio"]:checked').count();
  check(after === 1, "the card's select drives the candidate list", `saw ${after}`);

  // --- a stranded run has to be findable ------------------------------------
  // A phone that locks mid-run leaves the row RUNNING forever: the server
  // finishes the analysis but nothing ever writes a terminal status, because
  // the status is written by the stream the phone dropped. History is the one
  // place an analyst goes looking for work they lost, and it was filtering
  // exactly those rows out.
  const db = new Database(process.env.UX_DB ?? "dev-ux.db");
  const analystId = db.prepare("select id from Analyst limit 1").get().id;
  db.prepare(
    `insert into Analysis
       (id, analystId, mode, input, status, model, effort, htsusRevision,
        appVersion, createdAt)
     values (?, ?, 'DESCRIPTION', ?, 'RUNNING', 'replay:test', 'n/a',
             '2026-hts-revision-15', '0.0.0-ux', ?)`,
  ).run(
    "ux-stranded-run",
    analystId,
    "run whose phone locked mid-analysis",
    Date.now(),
  );
  db.close();

  await page.goto(`${BASE}/history`, { waitUntil: "domcontentloaded" });
  check(
    await page
      .getByText("run whose phone locked mid-analysis")
      .first()
      .isVisible(),
    "a still-RUNNING analysis is listed under unresolved work",
  );
  check(
    await page.locator('a[href="/analyze/ux-stranded-run"]').first().isVisible(),
    "and it is linked, so the analyst can get back to it",
  );
} catch (e) {
  console.log("  FAIL  " + String(e.message || e).split("\n")[0]);
  failures++;
} finally {
  await browser.close();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
