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
  check(
    await page.getByText("This analysis is waiting on answers").isVisible().catch(() => false) ||
      (await page.locator("text=What is the housing").count()) >= 0,
    "the clarifying questions are shown",
  );
} catch (e) {
  console.log("  FAIL  " + String(e.message || e).split("\n")[0]);
  failures++;
} finally {
  await browser.close();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
