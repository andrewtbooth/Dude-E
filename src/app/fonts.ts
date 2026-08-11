import localFont from "next/font/local";

/**
 * The interface's three voices, and why there are three.
 *
 * This is a document tool. An analyst reads a candidate the way they read a
 * tariff page — scanning a ruled column of codes for the one that matches,
 * then reading the prose beside it. Those are two different reading tasks and
 * a single typeface serves them both badly.
 *
 * `Archivo` is the prose: a grotesque with tall x-height and unfussy shapes
 * that stays legible at the small sizes a GRI narrative forces on a phone.
 *
 * `Archivo Narrow` is for labels and column headings only. Customs paperwork
 * is dense with short field names above the values they describe — COUNTRY OF
 * ORIGIN, UNIT OF QUANTITY — and a condensed face lets those sit at a
 * readable size in the width available instead of wrapping or shrinking.
 *
 * `IBM Plex Mono` carries every number that means something: HTS codes, duty
 * rates, statistical suffixes. Its figures are tabular by construction, so a
 * column of ten-digit codes aligns digit under digit, which is how the digits
 * get compared in the first place.
 *
 * All three are exposed as CSS variables rather than class names, so the token
 * layer in `globals.css` stays the single place typography is assigned.
 */

export const archivo = localFont({
  src: "./fonts/archivo-latin-var.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-archivo",
  display: "swap",
  // Metric-matched to the fallback so a swap does not shift the layout. Without
  // these the first paint reflows every card the moment the webfont lands,
  // which on a slow phone connection is the whole page moving under a thumb.
  adjustFontFallback: "Arial",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto"],
});

export const archivoNarrow = localFont({
  src: "./fonts/archivo-narrow-latin-var.woff2",
  weight: "500 700",
  style: "normal",
  variable: "--font-archivo-narrow",
  display: "swap",
  adjustFontFallback: "Arial",
  fallback: ["ui-sans-serif", "system-ui", "Segoe UI Condensed", "Roboto Condensed"],
});

export const plexMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-400-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-600-latin.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
  fallback: ["ui-monospace", "SF Mono", "Cascadia Mono", "Menlo", "Consolas"],
});

/** Every font variable, for the `<html>` element. */
export const FONT_VARIABLES = [
  archivo.variable,
  archivoNarrow.variable,
  plexMono.variable,
].join(" ");
