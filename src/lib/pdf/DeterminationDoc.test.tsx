import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import {
  sampleDeterminationView,
  sampleSelectedCandidate,
} from "../../test/determination-fixture";
import { DeterminationDoc } from "./DeterminationDoc";

/** PDF magic bytes. */
function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

describe("DeterminationDoc", () => {
  it("renders a valid PDF", async () => {
    const buffer = await renderToBuffer(
      <DeterminationDoc view={sampleDeterminationView()} />,
    );

    expect(isPdf(buffer)).toBe(true);
    // A determination with this much content runs to several KB. A near-empty
    // buffer would mean sections silently failed to render.
    expect(buffer.length).toBeGreaterThan(4000);
  }, 30_000);

  it("renders when the analyst overrode the model's pick", async () => {
    const buffer = await renderToBuffer(
      <DeterminationDoc
        view={sampleDeterminationView({
          overrodeRecommendation: true,
          modelRecommendation: "7323.93.00.80",
          analystNote:
            "Section XV note is decisive here; prior entries used 9617 and CBP has not challenged them.",
        })}
      />,
    );
    expect(isPdf(buffer)).toBe(true);
  }, 30_000);

  it("renders a part-number analysis with researched product data", async () => {
    const buffer = await renderToBuffer(
      <DeterminationDoc
        view={sampleDeterminationView({
          subject: {
            mode: "PART_NUMBER",
            input: "HYD-32-SS-BLK",
            researched: {
              manufacturer: "Example Outdoors",
              product_name: "TrailFlask 32oz",
              summary:
                "A double-walled 18/8 stainless steel vacuum-insulated bottle with a powder-coated exterior and a polypropylene screw lid.",
              materials: ["18/8 stainless steel", "polypropylene"],
              function: "Insulated liquid container",
              end_use: "Consumer outdoor recreation",
              vendor_published_codes: [
                {
                  code: "9617.00.6000",
                  kind: "HTS",
                  source: "https://example.com/spec-sheet.pdf",
                },
              ],
              sources: [
                {
                  url: "https://example.com/trailflask",
                  what_it_supported: "Construction and materials",
                },
              ],
            },
            refinements: [],
          },
        })}
      />,
    );
    expect(isPdf(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(4000);
  }, 30_000);

  it("renders with no alternates, assumptions, or authorities", async () => {
    // The sparse case: an unambiguous good with a clean answer. Every optional
    // section must degrade to nothing rather than throwing.
    const buffer = await renderToBuffer(
      <DeterminationDoc
        view={sampleDeterminationView({
          alternates: [],
          assumptions: [],
          selected: {
            ...sampleSelectedCandidate(),
            cross_rulings: [],
            chapter_99: [],
            schedule_b: [],
            notes_applied: [],
          },
          subject: {
            mode: "DESCRIPTION",
            input: "A simple good.",
            researched: null,
            refinements: [],
          },
        })}
      />,
    );
    expect(isPdf(buffer)).toBe(true);
  }, 30_000);
});
