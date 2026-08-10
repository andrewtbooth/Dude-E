import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND, BRAND_CSS_VARIABLES, THEME_COLOR } from "./brand";

/**
 * The screen and the PDF render the same determination through two engines
 * that share nothing. `@react-pdf` has no cascade and cannot read a custom
 * property, so the palette is necessarily written twice — and a value changed
 * in one place and not the other is invisible until someone prints a
 * determination and notices it does not look like the screen it came from.
 *
 * These tests are the mechanism that stops that. They are not testing that the
 * colours are good; they are testing that the two copies are the same copy.
 */

const CSS = fs.readFileSync(
  path.join(process.cwd(), "src/app/globals.css"),
  "utf8",
);

/** The `:root` block only — the dark overrides deliberately differ. */
function lightRootBlock(): string {
  const start = CSS.indexOf(":root {");
  expect(start).toBeGreaterThan(-1);
  const end = CSS.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return CSS.slice(start, end);
}

function cssValue(variable: string): string | null {
  const match = new RegExp(`${variable}:\\s*([^;]+);`).exec(lightRootBlock());
  return match ? match[1].trim() : null;
}

describe("brand palette", () => {
  it.each(Object.entries(BRAND_CSS_VARIABLES))(
    "BRAND.%s matches %s in globals.css",
    (key, variable) => {
      const expected = BRAND[key as keyof typeof BRAND];
      expect(cssValue(variable)?.toLowerCase()).toBe(expected.toLowerCase());
    },
  );

  it("maps every brand colour to a variable", () => {
    // A colour added to BRAND without a mapping would silently escape the
    // check above, which is the failure mode this whole file exists to
    // prevent.
    expect(Object.keys(BRAND_CSS_VARIABLES).sort()).toEqual(
      Object.keys(BRAND).sort(),
    );
  });

  it("keeps the browser chrome on the page colour", () => {
    // themeColor lives in a Viewport export rather than the stylesheet, so a
    // page-background change otherwise leaves a phone's status bar painted the
    // previous colour with nothing to catch it.
    const layout = fs.readFileSync(
      path.join(process.cwd(), "src/app/layout.tsx"),
      "utf8",
    );
    expect(layout).toContain(`color: "${THEME_COLOR.light}"`);
    expect(layout).toContain(`color: "${THEME_COLOR.dark}"`);
    expect(THEME_COLOR.light).toBe(BRAND.page);
  });

  it("uses the brand palette in the PDF rather than its own hex codes", () => {
    // The determination document is the artifact people keep. If it carries
    // literal hex values, it drifts the moment the palette moves.
    const doc = fs.readFileSync(
      path.join(process.cwd(), "src/lib/pdf/DeterminationDoc.tsx"),
      "utf8",
    );
    const colorBlock = doc.slice(
      doc.indexOf("const COLORS"),
      doc.indexOf("const styles"),
    );
    expect(colorBlock).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(colorBlock).toContain("BRAND.");
  });
});
