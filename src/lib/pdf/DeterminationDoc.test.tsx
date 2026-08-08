import crypto from "node:crypto";
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

/**
 * The document must be a pure function of the determination row.
 *
 * `Determination.pdfSha256` is written once, on first issue, so a PDF in
 * circulation can be tied back to the row that produced it; the export route
 * alarms when a later render disagrees with the stored hash. That check is only
 * worth having if identical inputs render identical bytes. They did not: the
 * renderer stamps wall-clock time into /CreationDate and derives the /ID
 * trailer from it, so every re-issue tripped the alarm on a document that had
 * not changed. Pinning both dates to `decidedAt` fixed it, and this test is
 * what keeps it fixed — the failure mode is silent, and its cost is that
 * whoever reads the logs learns to ignore the alarm.
 */
describe("byte reproducibility", () => {
  it("renders identical bytes from identical inputs, across a clock tick", async () => {
    const view = sampleDeterminationView();

    const first = await renderToBuffer(<DeterminationDoc view={view} />);
    // The bug was a wall-clock read, so a same-millisecond comparison would
    // have passed while the real re-issue — minutes or months later — failed.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await renderToBuffer(<DeterminationDoc view={view} />);

    const hash = (buffer: Buffer) =>
      crypto.createHash("sha256").update(buffer).digest("hex");

    expect(hash(second)).toBe(hash(first));
  }, 30_000);

  it("moves the hash when something on the row actually changes", async () => {
    // The mirror of the above: a check that never fires is as useless as one
    // that always does, so confirm the bytes still track the inputs.
    const a = await renderToBuffer(
      <DeterminationDoc view={sampleDeterminationView()} />,
    );
    const b = await renderToBuffer(
      <DeterminationDoc
        view={sampleDeterminationView({ analystNote: "Reviewed with counsel." })}
      />,
    );

    expect(a.equals(b)).toBe(false);
  }, 30_000);
});

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
            schedule_b: null,
            reasoning: {
              ...sampleSelectedCandidate().reasoning,
              notes_applied: [],
            },
            tariff: {
              ...sampleSelectedCandidate().tariff,
              chapter_99: [],
            },
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

describe("automated checks section", () => {
  /** Extract the PDF's text so we can assert on what a reader actually sees. */
  async function textOf(view: Parameters<typeof DeterminationDoc>[0]["view"]) {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const buffer = await renderToBuffer(<DeterminationDoc view={view} />);
    const doc = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
    return (await extractText(doc, { mergePages: true })).text;
  }

  /**
   * Section headings are letter-spaced for display, and extraction returns
   * that spacing literally ("A U T O M A T E D"). Compare without whitespace
   * so the test asserts on the heading rather than on its typography.
   */
  const squashed = (text: string) => text.replace(/\s+/g, "");

  it("stays silent when the run passed every check", async () => {
    // The common case. A disclaimer on every document teaches people to skip it.
    const text = await textOf(sampleDeterminationView());
    expect(squashed(text)).not.toContain("AUTOMATEDCHECKS");
  }, 30_000);

  it("records codes the tariff check discarded", async () => {
    // These were shown to the analyst on screen and then vanished from the
    // record, making the exported document more confident than the run was.
    const text = await textOf(
      sampleDeterminationView({
        verification: {
          rejectedCodes: [
            { code: "9617.00.10.99", reason: "not present in this HTSUS revision" },
          ],
          corrections: [],
        },
      }),
    );
    expect(squashed(text)).toContain("AUTOMATEDCHECKS");
    expect(text).toContain("9617.00.10.99");
    expect(text).toContain("not present in this HTSUS revision");
  }, 30_000);

  it("records values the tariff overrode", async () => {
    const text = await textOf(
      sampleDeterminationView({
        verification: {
          rejectedCodes: [],
          corrections: [
            {
              htsCode: "9617.00.10.00",
              field: "duty.general",
              modelValue: "3.4%",
              indexValue: "7.2%",
            },
          ],
        },
      }),
    );
    expect(text).toContain("Values corrected from the tariff");
    expect(text).toContain("3.4%");
    expect(text).toContain("7.2%");
  }, 30_000);
});
