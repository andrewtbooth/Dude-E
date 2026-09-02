import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3112";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
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

  await page.fill("textarea", "plastic housing");
  await page.waitForFunction(
    () => {
      const b = [...document.querySelectorAll("button")].find(
        (x) => x.textContent?.trim() === "Classify",
      );
      return b && !b.disabled;
    },
    { timeout: 20000 },
  );
  await page.locator('button:has-text("Classify")').click();
  await page.waitForSelector("text=Candidate classifications", { timeout: 90000 });
  check(true, "needs_more_info run rendered");

  const badge = await page.locator("span").filter({ hasText: /^Model’s pick$/ }).count();
  check(badge === 0, "no MODEL'S PICK when the model declined to recommend", `saw ${badge}`);

  check(
    await page.getByText("No determination can be recorded").isVisible(),
    "export refused, with a reason, on a needs_more_info run",
  );
  check(
    (await page.locator('button:has-text("Record determination")').count()) === 0,
    "the record button is not offered at all",
  );
  // `count() >= 0` is always true, so this used to pass with no questions on
  // the page at all. The questions are the whole point of this state.
  check(
    (await page.locator("text=What is the housing").count()) > 0,
    "the clarifying questions are shown",
  );

  // --- the answer types the schema offers ------------------------------------
  // Single choice is exclusive; multi choice is not. The second used to render
  // as a text box with the options as a placeholder.
  const pressed = async (label) =>
    (await page.locator(`button:has-text("${label}")`).getAttribute("aria-pressed")) === "true";
  const answered = () => page.locator("text=/\\d of 3 answered/").first().textContent();

  await page.locator('button:has-text("Plastic")').click();
  await page.locator('button:has-text("Steel")').click();
  check(
    !(await pressed("Plastic")) && (await pressed("Steel")),
    "a single-choice question keeps only the last option picked",
  );

  await page.locator('button:has-text("Terminals")').click();
  await page.locator('button:has-text("Gasket")').click();
  check(
    (await pressed("Terminals")) && (await pressed("Gasket")),
    "a multi-choice question keeps every option picked",
  );
  check((await answered()).startsWith("2 of 3"), "and both count as answered", await answered());

  await page.locator('button:has-text("Terminals")').click();
  check(
    !(await pressed("Terminals")) && (await pressed("Gasket")),
    "picking an option again drops only that one",
  );
  check((await answered()).startsWith("2 of 3"), "and the question stays answered while any remain", await answered());
} catch (e) {
  console.log("  FAIL  " + String(e.message || e).split("\n")[0]);
  failures++;
} finally {
  await browser.close();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
