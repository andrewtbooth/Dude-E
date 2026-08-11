/**
 * The palette, in the one place both renderers can agree on.
 *
 * This application draws the same determination twice, through two engines
 * that share nothing: the screen via CSS custom properties, and the PDF via
 * `@react-pdf/renderer`, which has no cascade, no variables, and no access to
 * a stylesheet. Each has historically carried its own hex codes, which means a
 * palette change lands in one and not the other, and the artifact stops
 * looking like the screen it was exported from — on a document whose whole
 * job is to be a faithful record of what the analyst saw.
 *
 * So the light palette lives here. The PDF imports it directly. `globals.css`
 * cannot import TypeScript, so it mirrors these values and `brand.test.ts`
 * parses the stylesheet and fails when the two disagree. That turns drift into
 * a failing test instead of a discrepancy nobody notices until a determination
 * is printed.
 *
 * Dark mode is deliberately absent: paper has no dark mode, and the PDF is
 * always the light palette on white.
 */

export const BRAND = {
  /* --- surfaces: warm paper, not dashboard grey ------------------------- */
  page: "#f7f7f5",
  surface1: "#ffffff",
  surface2: "#f2f1ed",
  surface3: "#eae9e3",

  /* --- rules -------------------------------------------------------------
   * Two weights, because a customs form uses two: hairlines dividing fields
   * inside a box, and heavier rules bounding the box itself. Collapsing them
   * into one border colour is what makes a form read as a grid of boxes
   * rather than as a structured document.
   */
  rule: "#dedcd4",
  ruleStrong: "#c6c3b8",

  /* --- text ---------------------------------------------------------------
   * `muted` is #6b6962 rather than a lighter grey because anything lighter
   * drops below 4.5:1 on white, and captions are set small.
   */
  ink: "#14130f",
  body: "#52514e",
  muted: "#6b6962",

  /* --- accent -------------------------------------------------------------
   * A deep harbour teal rather than the default corporate blue. It reads as
   * ink on a shipping document instead of as a web link, holds 7:1 on white
   * so it can carry small text, and stays distinguishable from the semantic
   * blue used for informational notices.
   */
  accent: "#0f5666",
  accentHover: "#0b4351",
  accentSubtle: "#e3eff2",

  /* --- semantic ---------------------------------------------------------- */
  ok: "#1d7a4c",
  okSubtle: "#e6f4ec",
  warn: "#8a5208",
  warnSubtle: "#fbf0dc",
  danger: "#a52a1a",
  dangerSubtle: "#fbeae7",
  info: "#2a5f8f",
  infoSubtle: "#e8f0f7",
} as const;

/**
 * Which CSS custom property in `globals.css` carries each brand value.
 *
 * The mapping is explicit rather than derived from the key names so that
 * renaming either side is a deliberate edit in one place, and so the test can
 * report which pair drifted rather than that "something" did.
 */
export const BRAND_CSS_VARIABLES: Record<keyof typeof BRAND, string> = {
  page: "--page",
  surface1: "--surface-1",
  surface2: "--surface-2",
  surface3: "--surface-3",
  rule: "--border",
  ruleStrong: "--border-strong",
  ink: "--text-primary",
  body: "--text-secondary",
  muted: "--text-muted",
  accent: "--accent",
  accentHover: "--accent-hover",
  accentSubtle: "--accent-subtle",
  ok: "--ok",
  okSubtle: "--ok-subtle",
  warn: "--warn",
  warnSubtle: "--warn-subtle",
  danger: "--danger",
  dangerSubtle: "--danger-subtle",
  info: "--info",
  infoSubtle: "--info-subtle",
};

/**
 * The browser-chrome colour for each scheme, as `layout.tsx` declares it.
 *
 * Exported so the same test that guards the palette guards this too. It is the
 * easiest thing in the app to forget: it lives in a `Viewport` export rather
 * than in the stylesheet, so a page background change leaves a phone's status
 * bar painted the old colour with nothing to catch it.
 */
export const THEME_COLOR = {
  light: BRAND.page,
  dark: "#131311",
} as const;
