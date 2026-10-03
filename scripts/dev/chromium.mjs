import fs from "node:fs";
import { chromium } from "playwright";

/**
 * Launch Chromium for the browser checks, wherever it happens to live.
 *
 * Every one of these scripts used to hardcode `/opt/pw-browsers/chromium`.
 * That path is real but it belongs to one specific container image — the
 * sandbox this project was built in — and it is not where Playwright puts a
 * browser anywhere else. So on any other machine all eight scripts failed at
 * `chromium.launch` with an ENOENT naming a path the reader had never heard
 * of, and nothing in the documentation mentioned Playwright at all.
 *
 * That mattered more than a broken dev script usually would, because
 * CLAUDE.md calls these suites "not optional for UI work" and two defects were
 * caught only here. A check nobody outside one container can run is a check
 * the next environment does not have.
 *
 * Three ways to find a browser, in order:
 *
 *   1. `PLAYWRIGHT_CHROMIUM_PATH`, for a host that keeps one somewhere
 *      specific — an offline or air-gapped environment where a system
 *      Chromium is installed by the image rather than downloaded.
 *   2. The sandbox path, when it exists.
 *   3. Nothing — let Playwright resolve the browser it manages itself, which
 *      is what `npx playwright install chromium` provides.
 */
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";

export function chromiumExecutablePath() {
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (override) return override;
  return fs.existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined;
}

/**
 * Fails with a message that says what to do, rather than an ENOENT on a path
 * the reader has no reason to recognise.
 */
export async function launchChromium(options = {}) {
  const executablePath = chromiumExecutablePath();
  try {
    return await chromium.launch(
      executablePath ? { ...options, executablePath } : options,
    );
  } catch (error) {
    throw new Error(
      `Could not launch Chromium for the browser checks.\n` +
        (executablePath
          ? `  Tried: ${executablePath}\n`
          : `  No browser found. Playwright manages its own; install one with:\n` +
            `    npx playwright install chromium\n`) +
        `  Or point PLAYWRIGHT_CHROMIUM_PATH at a Chromium or Chrome binary.\n` +
        `  Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
