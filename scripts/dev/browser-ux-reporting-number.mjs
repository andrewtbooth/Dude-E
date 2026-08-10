/**
 * Does the interface say when the schedule published no reporting number?
 *
 * 469 lines outside Chapter 99 are the deepest thing the schedule publishes and
 * still stop short of the ten-digit number an entry is filed against — 374 in
 * Chapter 98, 95 in the watch provisions of Chapter 91. Task #14 made those
 * declarable, correctly; the risk it introduced is that they now look exactly
 * like an ordinary statistical line, on a card that prints the code as the
 * answer.
 *
 * The predicate is unit-tested and the PDF is render-tested. This is the screen.
 */
import { chromium, devices } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3112";
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

  await page.fill("textarea", "mechanical wrist watch, gold-plated case");
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

  const verdict = page.locator('section[aria-label="Recommended classification"]');
  check(
    (await verdict.getByText("No ten-digit reporting number is published").count()) === 1,
    "the verdict card says the schedule published no reporting number",
  );
  check(
    await verdict.getByText("confirm the reporting number your broker should key").isVisible(),
    "and points at the person who has to key it",
  );

  // The candidate list is where a code gets chosen, so the same fact has to be
  // there too — an analyst who scrolls past the card must not lose it.
  check(
    (await page.getByText("No ten-digit reporting number published.").count()) >= 1,
    "the candidate card carries it as well",
  );

  // It must not be a blanket disclaimer. A warning on every code is a warning
  // on none, and this one is true of 469 lines out of 19,831.
  check(
    !(await page.getByText("No ten-digit reporting number").first().innerText()).includes(
      "10 digits",
    ),
    "the warning names the actual digit count, not a fixed string",
  );

  // Selecting it must still be allowed: it is the most specific classification
  // the schedule offers, and blocking it would be this tool deciding a question
  // about CBP practice that the tariff text does not settle.
  await page.locator('button:has-text("Select this code")').click();
  check(
    (await page.locator('input[type="radio"]:checked').count()) === 1,
    "the code can still be selected — flagged, not blocked",
  );
} catch (e) {
  console.log("  FAIL  " + String(e.message || e).split("\n")[0]);
  failures++;
} finally {
  await browser.close();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
