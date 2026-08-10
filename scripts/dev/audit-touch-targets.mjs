/**
 * Measure every interactive element at phone width.
 *
 * "Make the buttons bigger" is a guess. This is the list: every control the
 * analyst can hit, its rendered size, and how far it sits from its neighbours.
 * 44x44 CSS px is the floor both platform guidelines land on, and spacing
 * matters as much as size — two 44px targets sharing an edge still produce
 * mis-taps.
 *
 *   BASE=http://127.0.0.1:3113 node scripts/dev/audit-touch-targets.mjs
 */
import { chromium, devices } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:3113";
const MIN = 44;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
});
const context = await browser.newContext(devices["iPhone 13"]);
const page = await context.newPage();

const measure = () =>
  page.evaluate((min) => {
    const nodes = [
      ...document.querySelectorAll(
        'a, button, input:not([type="hidden"]), textarea, select, summary, [role="radio"]',
      ),
    ];
    return nodes
      .map((node) => {
        // A checkbox or radio inside a <label> is tapped via the label, so the
        // label is the target. Measuring the input reported the app's candidate
        // radio as 20x20 when the thing under the thumb was 44x44 — a false
        // failure, and the kind that gets a real one dismissed alongside it.
        const hit =
          (node.tagName === "INPUT" &&
            (node.type === "radio" || node.type === "checkbox") &&
            node.closest("label")) ||
          node;
        const r = hit.getBoundingClientRect();
        const label = (node.textContent || node.getAttribute("aria-label") || node.id || node.tagName)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 46);
        const styles = getComputedStyle(node);
        return {
          label,
          tag: node.tagName.toLowerCase(),
          w: Math.round(r.width),
          h: Math.round(r.height),
          fontSize: parseFloat(styles.fontSize),
          visible: r.width > 0 && r.height > 0,
        };
      })
      .filter((e) => e.visible && (e.h < min || e.w < min));
  }, MIN);

async function report(name) {
  const small = await measure();
  console.log(`\n  ${name} — ${small.length} target(s) under ${MIN}px`);
  for (const e of small) {
    console.log(
      `    ${String(e.w).padStart(4)}x${String(e.h).toString().padEnd(4)} ` +
        `${e.tag.padEnd(9)} ${e.label}`,
    );
  }
  return small.length;
}

let total = 0;
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  total += await report("sign-in");

  await page.fill("#name", "Dana Okafor");
  await page.fill("#email", "dana.okafor@example.com");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/analyze", { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  total += await report("/analyze, empty");

  // Text inputs under 16px make iOS Safari zoom the viewport on focus, which
  // is a usability defect distinct from target size — report it separately.
  const zoomers = await page.evaluate(() =>
    [...document.querySelectorAll("input, textarea, select")]
      .filter((n) => parseFloat(getComputedStyle(n).fontSize) < 16)
      .map((n) => `${n.tagName.toLowerCase()}#${n.id || "(no id)"}`),
  );
  console.log(`\n  inputs below 16px (iOS zooms these on focus): ${zoomers.length}`);
  for (const z of zoomers) console.log(`    ${z}`);
  total += zoomers.length;

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
  await page.waitForSelector("text=Candidate classifications", { timeout: 120000 });
  total += await report("/analyze, result");

  await page.goto(`${BASE}/history`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  total += await report("/history");

  // How far the primary action sits from the bottom of the viewport — the
  // reachable zone on a phone held one-handed is the lower third.
  await page.goto(`${BASE}/analyze`, { waitUntil: "domcontentloaded" });
  console.log("");
} finally {
  console.log(`\n  ${total} issue(s) total`);
  await browser.close();
  // Non-zero on any shortfall, so this can guard the state rather than merely
  // describe it. It went 37 -> 0; without an exit code the next component to
  // land a 16px control would put it quietly back to 1.
  process.exit(total === 0 ? 0 : 1);
}
