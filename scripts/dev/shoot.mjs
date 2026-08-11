/**
 * Screenshot the app against a cassette, at phone width, in both themes.
 *
 * Design work needs looking at, not reasoning about. This drives a replayed
 * run to a finished result and captures the screens an analyst actually sees,
 * so a change to the type scale or the palette can be judged rather than
 * asserted. No API spend.
 *
 *   BASE=http://127.0.0.1:3113 node scripts/dev/shoot.mjs /tmp/shots
 */
import fs from "node:fs";
import { chromium, devices } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3113";
const OUT = process.argv[2] ?? "/tmp/shots";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
});

for (const theme of ["light", "dark"]) {
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    colorScheme: theme,
  });
  const page = await context.newPage();

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.screenshot({ caret: "initial", path: `${OUT}/01-signin-${theme}.png`, fullPage: true });

  await page.fill("#name", "Dana Okafor");
  await page.fill("#email", "dana.okafor@example.com");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/analyze", { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  await page.screenshot({ caret: "initial", path: `${OUT}/02-analyze-${theme}.png`, fullPage: true });

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

  await page.waitForSelector('section[aria-label="Analysis progress"]');
  await page.waitForTimeout(2500);
  await page.screenshot({ caret: "initial", path: `${OUT}/03-running-${theme}.png`, fullPage: true });

  await page.waitForSelector("text=Candidate classifications", { timeout: 120000 });
  await page.screenshot({ caret: "initial", path: `${OUT}/04-result-${theme}.png`, fullPage: true });

  // The card with its reasoning open — the densest screen in the app.
  await page.locator('button:has-text("Show GRI analysis")').first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ caret: "initial", path: `${OUT}/05-reasoning-${theme}.png`, fullPage: true });

  await page.goto(`${BASE}/history`, { waitUntil: "domcontentloaded" });
  await page.screenshot({ caret: "initial", path: `${OUT}/06-history-${theme}.png`, fullPage: true });

  await context.close();
}

await browser.close();
console.log(`shots in ${OUT}`);
