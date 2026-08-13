/**
 * Does the interface say where a Chapter 91 reporting number comes from?
 *
 * The 95 watch and clock provisions are eight digits with nothing beneath them,
 * so on a card that prints the code as the answer they look exactly like an
 * ordinary statistical line. They are not: chapter statistical note 1 publishes
 * their ten-digit suffixes, and requires the watch to be constructively
 * separated into components and reported on a line each.
 *
 * An earlier version of this file asserted the opposite — that the schedule
 * published no reporting number for them — and passed, because the screen said
 * it too. So these checks are also a guard against the wrong claim coming back.
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
    (await verdict.getByText("built from a chapter statistical note").count()) === 1,
    "the verdict card says where the reporting number comes from",
  );
  check(
    await verdict.getByText("constructively separated").isVisible(),
    "and says what the note requires of the entry",
  );

  // The claim this replaced. It was false, it was printed on the answer, and
  // nothing should reintroduce it.
  check(
    (await page.getByText("No ten-digit reporting number is published").count()) === 0,
    "and does not claim the schedule published nothing",
  );

  // The candidate list is where a code gets chosen, so the same fact has to be
  // there too — an analyst who scrolls past the card must not lose it.
  check(
    (await page.getByText("Reporting number comes from a chapter statistical note.").count()) >= 1,
    "the candidate card carries it as well",
  );

  // It must not be a blanket disclaimer. A note on every code is a note on
  // none, and this one is true of 95 lines out of 19,926. Read off the whole
  // paragraph rather than the highlighted phrase, since the digit count is in
  // the prose that follows it.
  check(
    (await verdict.innerText()).includes("8-digit subheading"),
    "the note names the actual digit count, not a fixed string",
  );

  // Selecting it must still be allowed: the eight-digit subheading *is* the
  // classification, and the suffixes are a reporting step on top of it.
  await page.locator('button:has-text("Select this code")').click();
  check(
    (await page.locator('input[type="radio"]:checked').count()) === 1,
    "the code can still be selected — annotated, not blocked",
  );
} catch (e) {
  console.log("  FAIL  " + String(e.message || e).split("\n")[0]);
  failures++;
} finally {
  await browser.close();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
