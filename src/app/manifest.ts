import type { MetadataRoute } from "next";
import { BRAND, THEME_COLOR } from "@/lib/brand";

/**
 * Installable to a home screen, deliberately and only now.
 *
 * `display: "standalone"` removes the browser chrome — including the back
 * button and the address bar. That is worth having for a tool used dozens of
 * times a day from a phone, and it is actively hostile in an app whose only
 * navigation lives in a masthead at the top of a scrolling page. The bottom
 * nav is what makes this safe to turn on: every destination stays reachable
 * with no browser affordances at all.
 *
 * Portrait is not locked. An analyst reading a GRI narrative or a wide duty
 * table may well want landscape, and forcing orientation is the kind of
 * decision that reads as polish and lands as an obstruction.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dude-E — U.S. Tariff Classification",
    short_name: "Dude-E",
    description:
      "HTSUS classification with the GRI analysis written out, and exportable determinations.",
    start_url: "/analyze",
    display: "standalone",
    background_color: BRAND.page,
    theme_color: THEME_COLOR.light,
    // The app is behind sign-in and stamps every artifact with an analyst
    // identity; there is nothing here for a search index or an app store.
    orientation: "any",
    icons: [
      {
        src: "/icon.svg",
        // "any maskable" is a lie on most icons — a maskable icon needs its
        // content inside a safe circle or Android crops it. Declaring only
        // "any" gets a letterboxed icon instead of a cropped one.
        purpose: "any",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
