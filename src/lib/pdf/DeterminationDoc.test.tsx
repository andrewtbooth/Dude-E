import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

/**
 * Chapter 99 must be answered on the page, either way.
 *
 * The failure this guards is not a crash — it is a document that looks clean
 * precisely when it is least trustworthy. A code the screening does not cover
 * produced a determination with no additional-duty section at all, under a
 * footer implying Chapter 99 had been considered, and a reader could not tell
 * that from "screened, nothing applies".
 */
/** Render a determination and read its text back out. */
async function textOf(view: Parameters<typeof DeterminationDoc>[0]["view"]) {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const buffer = await renderToBuffer(<DeterminationDoc view={view} />);
  const doc = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
  return (await extractText(doc, { mergePages: true })).text;
}

/** Section and callout titles are letter-spaced for display; compare without whitespace. */
const squashed = (text: string) => text.replace(/\s+/g, "");

describe("Chapter 99 disclosure", () => {
  /** The same fixture with nothing matched — the case that used to render blank. */
  function withNoChapter99() {
    const view = sampleDeterminationView();
    return {
      ...view,
      selected: {
        ...view.selected,
        tariff: { ...view.selected.tariff, chapter_99: [] },
      },
    };
  }

  it("states the negative when nothing was matched", async () => {
    const text = await textOf(withNoChapter99());
    expect(squashed(text)).toContain(squashed("SCREENING IS INCOMPLETE"));
    expect(squashed(text)).toContain(squashed("not a finding that none applies"));
  }, 30_000);

  it("says how far the screening actually reaches", async () => {
    // The count is what separates a caveat from a measurement: a reader can
    // size 267 of 19,949 for themselves, where "may be incomplete" tells them
    // nothing they can act on.
    const text = await textOf(withNoChapter99());
    expect(squashed(text)).toContain("267");
    expect(squashed(text)).toContain(squashed("19,949"));
  }, 30_000);

  it("singles out Chinese-origin goods, where the gap actually bites", async () => {
    const text = await textOf(withNoChapter99());
    expect(squashed(text)).toContain(squashed("unscreened rather than as clear"));
  }, 30_000);

  it("still lists the provisions when duties were matched", async () => {
    const text = await textOf(sampleDeterminationView());
    expect(squashed(text)).toContain(squashed("ADDITIONAL DUTIES MAY APPLY"));
  }, 30_000);

  it("puts Chapter 99 in the footer's excluded scope, not merely 'stale'", async () => {
    const text = await textOf(sampleDeterminationView());
    expect(squashed(text)).toContain(squashed("screened only partially"));
    expect(squashed(text)).toContain(
      squashed("does not establish that none apply"),
    );
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
          substitutedRecommendation: null,
          reportingNumberNotes: [],
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
              severity: "material" as const,
            },
          ],
          substitutedRecommendation: null,
          reportingNumberNotes: [],
        },
      }),
    );
    expect(text).toContain("Values corrected from the tariff");
    expect(text).toContain("3.4%");
    expect(text).toContain("7.2%");
  }, 30_000);

  it("counts wording differences instead of itemising them", async () => {
    // Every real correction seen so far has been a leading tariff number or a
    // trailing colon on a description the model quoted. Listing those at full
    // length pushed a genuine duty-rate correction off the reader's attention,
    // so they are summarised — but not dropped, because the reader is entitled
    // to know the model's transcription did not match the published text.
    const text = await textOf(
      sampleDeterminationView({
        verification: {
          rejectedCodes: [],
          corrections: [
            {
              htsCode: "9617.00.10.00",
              field: "description_path",
              modelValue: "9617.00 Vacuum flasks and other vacuum vessels",
              indexValue: "Vacuum flasks and other vacuum vessels:",
              severity: "transcription" as const,
            },
          ],
          substitutedRecommendation: null,
          reportingNumberNotes: [],
        },
      }),
    );
    const flat = squashed(text);
    expect(flat).toContain("Wordingnormalised");
    expect(flat).not.toContain("Valuescorrectedfromthetariff");
    expect(flat).not.toContain("9617.00Vacuumflasks");
  }, 30_000);
});

describe("the fixed footer and the space reserved for it", () => {
  /**
   * The footer is absolutely positioned, so the page reserves room for it by
   * arithmetic — `paddingBottom` — and nothing pushes back when that number is
   * too small. It was too small: an eight-line disclaimer at 7pt overlapped
   * the last paragraph of body text on page one, printing both on top of each
   * other. Every text assertion in this file passed throughout, because
   * extracting text from a PDF does not care whether the glyphs collide.
   *
   * So this reads the source rather than the render. It cannot see overlap,
   * but it can see the thing that caused it — a footer growing past the space
   * set aside for it — and say so at the point where someone is editing the
   * text.
   */
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/lib/pdf/DeterminationDoc.tsx"),
    "utf8",
  );

  it("keeps the per-page footer to about two lines", () => {
    const body = /<Text style={styles\.footerText}>([\s\S]*?)<\/Text>/.exec(
      source,
    )?.[1];
    expect(body).toBeDefined();
    const words = body!.trim().split(/\s+/).length;

    // ~24 words fits two lines at 7pt across the reserved width. Well past
    // that and `paddingBottom` on `styles.page` has to grow with it — and the
    // rendered page has to be looked at, which no test here can do.
    expect(words).toBeLessThan(40);
  });

  it("still says everything it used to, in a section", async () => {
    // Moving the text out of the footer must not quietly drop any of it.
    const text = squashed(await textOf(sampleDeterminationView()));
    for (const clause of [
      "SCOPE AND LIMITATIONS",
      "not a ruling letter",
      "self-asserted at sign-in and not authenticated",
      "screened only partially",
      "does not establish that none apply",
      "19 CFR Part 177",
      "confirm currency before filing",
    ]) {
      expect(text).toContain(squashed(clause));
    }
  }, 30_000);
});

describe("a recommendation the model did not actually make", () => {
  /**
   * When verification rejects the model's own pick, the application promotes
   * the best surviving candidate — which is the right recovery and an invisible
   * one. `recommended_hts_code` comes back populated either way, so months
   * later a reader of this document has no way to tell the code above was a
   * fallback rather than the analysis's conclusion. That matters more on paper
   * than on screen: the screen had a run behind it, the document is all that
   * is left.
   */
  it("says so, and names the code the model actually gave", async () => {
    const view = sampleDeterminationView();
    const text = squashed(
      await textOf({
        ...view,
        verification: {
          ...view.verification,
          substitutedRecommendation: {
            modelSaid: "9617.00.10.99",
            using: "9617.00.10.00",
          },
        },
      }),
    );

    expect(text).toContain(squashed("did not recommend the code it appeared to"));
    expect(text).toContain("9617.00.10.99");
    expect(text).toContain(squashed("Weigh the rest of the reasoning accordingly"));
  }, 30_000);

  it("stays silent when the model's own pick verified", async () => {
    // The common case. This section appearing on every determination would
    // make it furniture.
    const text = squashed(await textOf(sampleDeterminationView()));
    expect(text).not.toContain(squashed("did not recommend the code it appeared to"));
  }, 30_000);
});

describe("a determination on a code whose reporting number is in a note", () => {
  /**
   * Louder on paper than on screen, and deliberately so. This document prints
   * a code under a heading that says DETERMINATION, and whoever reads it
   * months from now has no way to know that keying it takes a step the code
   * does not show unless the page says so.
   *
   * The page used to say the opposite of the truth — that no ten-digit number
   * was published for the line. Chapter 91 statistical note 1 publishes them
   * all, as suffixes on separately valued components, so what the document
   * owes the reader is the scheme, not a warning.
   */
  const onWatchProvision = () => {
    const view = sampleDeterminationView();
    return {
      ...view,
      selected: { ...view.selected, hts_code: "9101.11.40" },
      verification: {
        ...view.verification,
        reportingNumberNotes: [
          {
            code: "9101.11.40",
            digits: 8,
            source: "chapter_statistical_note" as const,
            footnote: "See statistical note 1 to this chapter.",
          },
        ],
      },
    };
  };

  it("names the note the schedule pointed at", async () => {
    const text = squashed(await textOf(onWatchProvision()));
    expect(text).toContain(
      squashed("REPORTING NUMBER IS BUILT FROM A CHAPTER STATISTICAL NOTE"),
    );
    expect(text).toContain(squashed("See statistical note 1 to this chapter."));
  }, 30_000);

  it("explains the constructive separation the note requires", async () => {
    // Without this the reader is told to go read a note and not why. The
    // filing consequence — a line per component, including absent ones at
    // zero — is the part that changes what they do.
    const text = squashed(await textOf(onWatchProvision()));
    expect(text).toContain(squashed("constructively separated into its components"));
    expect(text).toContain(squashed("at zero quantity and value"));
  }, 30_000);

  it("no longer claims the schedule published nothing", async () => {
    const text = squashed(await textOf(onWatchProvision()));
    expect(text).not.toContain(squashed("NO TEN-DIGIT REPORTING NUMBER"));
  }, 30_000);

  it("stays silent on an ordinary ten-digit line", async () => {
    const text = squashed(await textOf(sampleDeterminationView()));
    expect(text).not.toContain(squashed("CHAPTER STATISTICAL NOTE"));
    expect(text).not.toContain(squashed("NO TEN-DIGIT REPORTING NUMBER"));
  }, 30_000);
});
