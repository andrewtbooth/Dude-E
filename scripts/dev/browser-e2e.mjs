import { chromium } from "playwright";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3111";
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
  check(true, "sign-in lands on /analyze");

  await page.waitForLoadState("networkidle");
  await page.fill("textarea", "stainless steel vacuum-insulated water bottle, 750ml");
  // The Classify button is disabled until React hydrates and sees the input,
  // so waiting for it to enable is also waiting for hydration. Clicking early
  // submits the form natively and the page just reloads.
  const classify = page.locator('button:has-text("Classify")');
  await classify.waitFor({ state: "visible" });
  await page.waitForFunction(
    () => {
      const b = [...document.querySelectorAll("button")].find((x) =>
        x.textContent?.trim() === "Classify",
      );
      return b && !b.disabled;
    },
    { timeout: 20000 },
  );
  await classify.click();
  await page.waitForSelector("text=Candidate classifications", { timeout: 90000 });
  check(true, "replayed run rendered (no API call)");

  // Count the badge element itself. getByText matches ancestors too, so a
  // substring locator reports the span plus every wrapper around it.
  const badges = await page.locator("span").filter({ hasText: /^Model’s pick$/ }).count();
  check(badges === 1, "exactly one MODEL'S PICK badge", `saw ${badges}`);

  const preselected = await page.locator('input[type="radio"]:checked').count();
  check(preselected === 0, "nothing pre-selected — the analyst must choose");

  await page.locator('input[type="radio"]').first().check();
  await page.locator('button:has-text("Record determination")').click();
  await page.waitForSelector('a:has-text("Open the determination PDF")', { timeout: 30000 });
  check(true, "determination recorded; PDF offered as a link, not a popup");

  const href = await page.locator('a:has-text("Open the determination PDF")').getAttribute("href");

  const db = new Database("dev-e2e.db", { readonly: true });
  const analysisId = db.prepare("select id from Analysis order by rowid desc limit 1").get().id;
  // Per analysis, not global: the constraint is one determination per analysis,
  // and a database reused across runs legitimately holds several.
  const detCount = db
    .prepare("select count(*) c from Determination where analysisId = ?")
    .get(analysisId).c;
  db.close();
  check(detCount === 1, "exactly one determination row", `saw ${detCount}`);

  const dup = await page.evaluate(async (aid) => {
    const r = await fetch("/api/determinations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisId: aid, selectedHtsCode: "9617.00.10.00" }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, analysisId);
  check(dup.status === 409, "second record attempt is refused", `status ${dup.status}`);
  check(
    typeof dup.body?.determinationId === "string",
    "refusal points at the existing determination",
  );

  await page.goto(`${BASE}/analyze/${analysisId}`, { waitUntil: "domcontentloaded" });
  check(
    await page.getByText("A determination has already been recorded").isVisible(),
    "/analyze/[id] opens and shows the existing determination",
  );
  check(
    await page.getByText("9617.00.10.00").first().isVisible(),
    "/analyze/[id] renders the run through the shared component",
  );

  const pdf = await page.request.get(`${BASE}${href}`);
  const bytes = Buffer.from(await pdf.body());
  check(
    pdf.status() === 200 && bytes.subarray(0, 5).toString() === "%PDF-",
    "determination PDF serves",
    `${pdf.status()}, ${Math.round(bytes.length / 1024)} KB`,
  );

  const second = await page.request.get(`${BASE}${href}`);
  const again = Buffer.from(await second.body());
  check(bytes.equals(again), "re-issued PDF is byte-identical (hash alarm stays quiet)");
} catch (e) {
  console.log("  FAIL  " + String(e.message || e).split("\n")[0]);
  failures++;
} finally {
  await browser.close();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
