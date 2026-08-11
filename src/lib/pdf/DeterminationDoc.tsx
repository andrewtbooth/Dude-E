import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";
import type { Candidate } from "../agent/schema";
import { BRAND } from "../brand";
import { hasPublishedReportingNumber } from "../hts/parse";
import type { DeterminationView } from "./types";

/**
 * The exported determination.
 *
 * Written as a compliance record rather than a report: provenance first, the
 * conclusion stated plainly, then the reasoning, then what was considered and
 * rejected. Someone reading this months later — possibly a CBP import
 * specialist — should be able to reconstruct the decision without access to
 * this application.
 */

/**
 * Named for the roles this document uses, valued from the shared palette.
 *
 * The indirection is the point: these were literal hex codes, which meant the
 * exported determination kept the palette it was written with while the screen
 * moved on. `brand.test.ts` fails if a hex code reappears here.
 */
const COLORS = {
  ink: BRAND.ink,
  body: BRAND.body,
  muted: BRAND.muted,
  rule: BRAND.rule,
  accent: BRAND.accent,
  warn: BRAND.warn,
  panel: BRAND.surface2,
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 44,
    /**
     * Must clear the fixed footer, which is taller than it looks.
     *
     * The footer is absolutely positioned, so the page reserves its space by
     * arithmetic rather than by layout — nothing pushes back if the number is
     * too small. It was 60 against a footer that ran to eight lines, and body
     * text descended straight through: on the sample determination the last
     * line of the Chapter 99 note printed on top of the disclaimer, both
     * illegible. No test catches it, because the text extractor reads
     * overlapping strings perfectly happily.
     *
     * 54 = 26 (offset from the page edge) + ~18 (two lines at 7pt) + 10 clear.
     * If the footer text grows, this has to grow with it, and the rendered
     * page has to be looked at — `npm run dev:pdf`.
     */
    paddingBottom: 54,
    paddingHorizontal: 48,
    fontSize: 9.5,
    lineHeight: 1.5,
    color: COLORS.body,
    fontFamily: "Helvetica",
  },

  docTitle: { fontSize: 16, fontFamily: "Helvetica-Bold", color: COLORS.ink },
  docSubtitle: { fontSize: 9, color: COLORS.muted, marginTop: 2 },

  provenance: {
    marginTop: 12,
    padding: 10,
    backgroundColor: COLORS.panel,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.accent,
  },
  provenanceRow: { flexDirection: "row", marginBottom: 2 },
  provenanceLabel: { width: 110, color: COLORS.muted, fontSize: 8.5 },
  provenanceValue: { flex: 1, fontSize: 8.5, color: COLORS.ink },

  section: { marginTop: 18 },
  sectionTitle: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.1,
    color: COLORS.muted,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.rule,
    paddingBottom: 3,
    marginBottom: 7,
  },

  code: { fontFamily: "Courier-Bold", fontSize: 18, color: COLORS.ink },
  codeInline: { fontFamily: "Courier", color: COLORS.ink },

  pathRow: { flexDirection: "row", marginTop: 2 },
  pathIndent: { color: COLORS.muted, fontFamily: "Courier", fontSize: 8 },
  pathText: { flex: 1, fontSize: 8.5, color: COLORS.body },

  dutyTable: { marginTop: 10, flexDirection: "row", flexWrap: "wrap" },
  dutyCell: { width: "25%", marginBottom: 6 },
  dutyLabel: { fontSize: 7.5, color: COLORS.muted, letterSpacing: 0.5 },
  dutyValue: { fontSize: 10, color: COLORS.ink },

  subhead: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: COLORS.ink,
    marginTop: 9,
    marginBottom: 2,
  },
  para: { marginBottom: 5 },

  bulletRow: { flexDirection: "row", marginBottom: 3 },
  bulletMark: { width: 12, color: COLORS.muted },
  bulletText: { flex: 1 },

  alternate: {
    marginBottom: 10,
    paddingBottom: 9,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.rule,
  },
  alternateHead: { flexDirection: "row", alignItems: "baseline" },
  alternateCode: { fontFamily: "Courier-Bold", fontSize: 10.5, color: COLORS.ink },
  alternateDesc: { flex: 1, marginLeft: 8, fontSize: 8.5, color: COLORS.muted },

  callout: {
    marginTop: 8,
    padding: 8,
    backgroundColor: "#fbf3e4",
    borderLeftWidth: 2,
    borderLeftColor: COLORS.warn,
  },
  calloutTitle: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: COLORS.warn,
    marginBottom: 2,
  },

  link: { color: COLORS.accent },

  footer: {
    position: "absolute",
    bottom: 26,
    left: 48,
    right: 48,
    borderTopWidth: 0.5,
    borderTopColor: COLORS.rule,
    paddingTop: 6,
  },
  // The page number sits top-right of the footer block, so the disclaimer
  // reserves that gutter rather than running underneath it.
  footerText: {
    fontSize: 7,
    color: COLORS.muted,
    lineHeight: 1.4,
    paddingRight: 38,
  },
  pageNumber: {
    position: "absolute",
    right: 0,
    top: 6,
    fontSize: 7,
    color: COLORS.muted,
  },
});

export function DeterminationDoc({ view }: { view: DeterminationView }) {
  return (
    <Document
      title={`HTSUS determination ${view.id}`}
      author={view.analyst.name}
      subject={`Classification of ${truncate(view.subject.input, 120)}`}
      creator="Dude-E Tariff Classification"
      // Pinned to the decision, not to the render, so the document is a pure
      // function of the frozen inputs.
      //
      // Left to itself the renderer stamps wall-clock time into /CreationDate
      // and derives the /ID trailer from it, which made every re-issue produce
      // different bytes: three renders of identical inputs gave three hashes,
      // differing in exactly those 61 bytes. The PDF route records a write-once
      // sha256 on first issue and alarms when a later render disagrees — an
      // alarm which, until now, fired every single time, on documents that were
      // in fact identical. An integrity check that always cries wolf is worse
      // than none: it trains whoever reads the logs to ignore the one case it
      // exists to catch.
      creationDate={view.decidedAt}
      modificationDate={view.decidedAt}
    >
      <Page size="LETTER" style={styles.page}>
        <Header view={view} />
        <Subject view={view} />
        <FinalDetermination view={view} />
        <GriSection candidate={view.selected} />
        <AssumptionsSection view={view} />
        <VerificationSection view={view} />
        <Chapter98Section view={view} />
        <AlternatesSection view={view} />
        <AuthoritiesSection view={view} />
        <ScopeSection />
        <Footer />
      </Page>
    </Document>
  );
}

// --- 1. Provenance header ---------------------------------------------------

function Header({ view }: { view: DeterminationView }) {
  return (
    <View>
      <Text style={styles.docTitle}>Tariff Classification Determination</Text>
      <Text style={styles.docSubtitle}>
        Harmonized Tariff Schedule of the United States
      </Text>

      <View style={styles.provenance}>
        <ProvenanceRow label="Determination ID" value={view.id} mono />
        <ProvenanceRow
          label="Analyst of record"
          value={`${view.analyst.name} <${view.analyst.email}>`}
        />
        <ProvenanceRow label="Decided" value={formatTimestamp(view.decidedAt)} />
        <ProvenanceRow
          label="Tariff edition"
          // Dated here rather than only in the Chapter 99 callout. That callout
          // renders only when additional duties were found, so on the common
          // document — and on precisely the document where a missed Section 301
          // matters most — the reader previously had no way to tell whether the
          // schedule behind it was pulled last week or last quarter. "How
          // current is this data" is the first question asked of a
          // machine-generated tariff document.
          value={
            view.tariffRetrievedAt
              ? `${view.htsusRevision} · retrieved ${formatTimestamp(view.tariffRetrievedAt)}`
              : `${view.htsusRevision} · retrieval date not recorded`
          }
        />
        <ProvenanceRow
          label="Export schedule"
          value={
            view.scheduleBEdition
              ? `Schedule B ${view.scheduleBEdition}`
              : "not synced — no export code determined"
          }
        />
        <ProvenanceRow
          label="Analysis"
          value={`${view.model}, ${view.effort} effort · Dude-E ${view.appVersion}`}
        />
      </View>
    </View>
  );
}

function ProvenanceRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.provenanceRow}>
      <Text style={styles.provenanceLabel}>{label}</Text>
      <Text
        style={[
          styles.provenanceValue,
          ...(mono ? [{ fontFamily: "Courier" as const }] : []),
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

// --- 2. Subject -------------------------------------------------------------

function Subject({ view }: { view: DeterminationView }) {
  const { subject } = view;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        {subject.mode === "PART_NUMBER" ? "SUBJECT PART" : "SUBJECT GOODS"}
      </Text>
      <Text style={styles.para}>{subject.input}</Text>

      {subject.researched && (
        <View>
          {subject.researched.manufacturer && (
            <Text style={styles.para}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Manufacturer: </Text>
              {subject.researched.manufacturer}
              {subject.researched.product_name
                ? ` — ${subject.researched.product_name}`
                : ""}
            </Text>
          )}
          <Text style={styles.para}>{subject.researched.summary}</Text>
          {subject.researched.materials.length > 0 && (
            <Text style={styles.para}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Materials: </Text>
              {subject.researched.materials.join(", ")}
            </Text>
          )}
          {subject.researched.function && (
            <Text style={styles.para}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Function: </Text>
              {subject.researched.function}
            </Text>
          )}
          {subject.researched.vendor_published_codes.length > 0 && (
            <View style={styles.callout}>
              <Text style={styles.calloutTitle}>
                CODES PUBLISHED BY THE VENDOR — NOT RELIED ON
              </Text>
              {subject.researched.vendor_published_codes.map((entry, index) => (
                <Text key={index} style={{ fontSize: 8 }}>
                  {entry.code} ({entry.kind}) — {entry.source}
                </Text>
              ))}
              <Text style={{ fontSize: 8, marginTop: 2 }}>
                Vendor-published codes are frequently stale, copied from a
                similar product, or correct for another country&#39;s tariff.
                The classification below was reached independently.
              </Text>
            </View>
          )}
        </View>
      )}

      {subject.refinements.length > 0 && (
        <View style={{ marginTop: 6 }}>
          <Text style={styles.subhead}>Information supplied by the analyst</Text>
          {subject.refinements.map((refinement, index) => (
            <View key={index} style={styles.bulletRow}>
              <Text style={styles.bulletMark}>—</Text>
              <Text style={styles.bulletText}>
                {refinement.question} {""}
                <Text style={{ fontFamily: "Helvetica-Bold" }}>
                  {refinement.answer}
                </Text>
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// --- 3. Final determination -------------------------------------------------

function FinalDetermination({ view }: { view: DeterminationView }) {
  const candidate = view.selected;
  return (
    /**
     * The section wraps; the headline does not.
     *
     * `wrap={false}` sat on the whole section, which was fine until it grew.
     * Adding the reporting-number callout tipped it past what fits after the
     * subject block, and @react-pdf moved the entire section to the next page
     * rather than splitting it — leaving a hand's width of white space on page
     * one and pushing the determination off the first page of a document whose
     * entire purpose is to state it. Keeping the code, its path and its rates
     * together is what actually mattered; where the prose after them breaks
     * does not.
     */
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>DETERMINATION</Text>

      <View wrap={false}>
        <Text style={styles.code}>{candidate.hts_code}</Text>

        <View style={{ marginTop: 6 }}>
          {candidate.description_path.map((segment, index) => (
            <View key={index} style={styles.pathRow}>
              <Text style={styles.pathIndent}>{"  ".repeat(index)}› </Text>
              <Text style={styles.pathText}>{segment}</Text>
            </View>
          ))}
        </View>

        <View style={styles.dutyTable}>
          <DutyCell label="GENERAL (COL. 1)" value={candidate.tariff.duty.general || "—"} />
          <DutyCell label="SPECIAL" value={candidate.tariff.duty.special || "—"} />
          <DutyCell label="COLUMN 2" value={candidate.tariff.duty.column_2 || "—"} />
          <DutyCell
            label="UNIT OF QUANTITY"
            value={candidate.tariff.unit_of_quantity.join(", ") || "—"}
          />
        </View>
      </View>

      {!hasPublishedReportingNumber(candidate.hts_code) && (
        // Louder here than on screen, and deliberately so. An entry is filed
        // against a ten-digit reporting number; this document prints a code
        // under a heading that says DETERMINATION, and whoever reads it months
        // from now has no way to know the schedule stopped short unless it
        // says so on the page.
        <View style={styles.callout}>
          <Text style={styles.calloutTitle}>
            NO TEN-DIGIT REPORTING NUMBER IS PUBLISHED FOR THIS LINE
          </Text>
          <Text style={{ fontSize: 8 }}>
            {view.htsusRevision} terminates this provision at{" "}
            {candidate.hts_code.replace(/\D/g, "").length} digits and publishes
            no unit of quantity for it, where every classifiable line in
            Chapters 1&ndash;97 carries both. It is the most specific
            classification the schedule offers, and this determination is a
            statement about classification, not about the reporting number to
            key. Confirm the entry number with the filer before use.
          </Text>
        </View>
      )}

      {candidate.tariff.duty.rates_published_on && (
        <Text style={{ fontSize: 7.5, color: COLORS.muted }}>
          Rates are published on {candidate.tariff.duty.rates_published_on} and
          inherited by this statistical reporting number.
        </Text>
      )}

      {candidate.schedule_b ? (
        <View style={{ marginTop: 6 }}>
          <Text style={{ fontSize: 8.5 }}>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>
              Schedule B (export):{" "}
            </Text>
            <Text style={styles.codeInline}>{candidate.schedule_b.code}</Text> —{" "}
            {candidate.schedule_b.description}
            {candidate.schedule_b.unit_of_quantity.length > 0
              ? ` (${candidate.schedule_b.unit_of_quantity.join(", ")})`
              : ""}
          </Text>
          <Text style={{ fontSize: 7.5, color: COLORS.muted, marginTop: 2 }}>
            {candidate.schedule_b.justification}
          </Text>
          {candidate.schedule_b.considered.length > 0 && (
            <Text style={{ fontSize: 7.5, color: COLORS.muted, marginTop: 2 }}>
              Also under this subheading:{" "}
              {candidate.schedule_b.considered
                .map(
                  (entry) =>
                    `${entry.code} (${entry.why_not_selected.replace(/\.$/, "")})`,
                )
                .join("; ")}
              .
            </Text>
          )}
        </View>
      ) : (
        <Text style={{ marginTop: 6, fontSize: 8.5, color: COLORS.muted }}>
          <Text style={{ fontFamily: "Helvetica-Bold" }}>
            Schedule B (export):{" "}
          </Text>
          no export code was established.
        </Text>
      )}

      <Chapter99Section view={view} candidate={candidate} />

      {view.overrodeRecommendation && (
        <View style={styles.callout}>
          <Text style={styles.calloutTitle}>ANALYST OVERRODE THE ANALYSIS</Text>
          <Text style={{ fontSize: 8 }}>
            The analysis ranked{" "}
            <Text style={styles.codeInline}>
              {view.modelRecommendation ?? "another code"}
            </Text>{" "}
            first. The analyst selected {candidate.hts_code}.
            {view.analystNote ? ` Reason given: ${view.analystNote}` : ""}
          </Text>
        </View>
      )}

      {!view.overrodeRecommendation && view.analystNote && (
        <Text style={{ marginTop: 6, fontSize: 8.5 }}>
          <Text style={{ fontFamily: "Helvetica-Bold" }}>Analyst note: </Text>
          {view.analystNote}
        </Text>
      )}
    </View>
  );
}

function DutyCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.dutyCell}>
      <Text style={styles.dutyLabel}>{label}</Text>
      <Text style={styles.dutyValue}>{value}</Text>
    </View>
  );
}

/**
 * Chapter 99 exposure — stated either way, never left as silence.
 *
 * This block used to render only when additional duties were found, which
 * meant the highest-exposure outcome produced the cleanest-looking page. A
 * Chinese-origin laptop that the screening missed came out reading
 * `GENERAL (COL. 1): Free` with no additional-duty section at all, on a
 * document whose footer implied Chapter 99 had been considered. A reader has
 * no way to distinguish "screened, nothing applies" from "not covered by the
 * screening", and those carry opposite consequences at entry.
 *
 * So the negative is now printed, with the reach of the screening attached.
 * The number is not decoration: coverage in this snapshot is derived from the
 * Chapter 99 notes as parsed, and it reaches a few hundred subheadings out of
 * roughly nineteen thousand declarable lines. Section 301 List 3 resolves to
 * thirteen. Saying so in the document is the difference between a caveat and a
 * measurement.
 */
function Chapter99Section({
  view,
  candidate,
}: {
  view: DeterminationView;
  candidate: Candidate;
}) {
  const asPublished =
    `as published in ${view.htsusRevision}` +
    (view.tariffRetrievedAt
      ? `, retrieved ${formatTimestamp(view.tariffRetrievedAt)}`
      : "") +
    ". Chapter 99 actions change more often than the HTSUS is revised, so " +
    "treat them as current only as of that date and confirm against the live " +
    "schedule before filing.";

  if (candidate.tariff.chapter_99.length > 0) {
    return (
      // minPresenceAhead rather than wrap={false}: this callout grows with the
      // number of provisions matched, and a block that refuses to split is
      // exactly what pushed the determination itself off page one. Asking for
      // 44pt of company keeps the heading from stranding alone at a page foot
      // without betting that the whole thing fits.
      <View style={styles.callout} minPresenceAhead={44}>
        <Text style={styles.calloutTitle}>ADDITIONAL DUTIES MAY APPLY</Text>
        {candidate.tariff.chapter_99.map((entry) => (
          <Text key={entry.hts_code} style={{ fontSize: 8, marginBottom: 2 }}>
            <Text style={styles.codeInline}>{entry.hts_code}</Text> ·{" "}
            {entry.program} — {entry.additional_duty}. {entry.applies_when}
          </Text>
        ))}
        <Text style={{ fontSize: 7.5, marginTop: 2 }}>
          These provisions are {asPublished}
        </Text>
      </View>
    );
  }

  const scope = view.chapter99Scope;

  return (
    <View style={styles.callout}>
      <Text style={styles.calloutTitle}>
        CHAPTER 99 — NO ADDITIONAL DUTY MATCHED, SCREENING IS INCOMPLETE
      </Text>
      <Text style={{ fontSize: 8, marginBottom: 2 }}>
        No Section 301, Section 232 or other Chapter 99 provision was matched to{" "}
        <Text style={styles.codeInline}>{candidate.hts_code}</Text> in this
        edition. That is not a finding that none applies.
      </Text>
      <Text style={{ fontSize: 7.5 }}>
        {scope
          ? `Screening is derived from the Chapter 99 notes as published, and in ` +
            `this snapshot reaches ${scope.subheadingsWithAdditionalDuty.toLocaleString()} ` +
            `of ${scope.declarableLines.toLocaleString()} declarable subheadings. ` +
            `Coverage of the Section 301 lists in particular is known to be ` +
            `partial. Screen origin-based additional duties independently before ` +
            `filing — for Chinese-origin goods especially, absence here should be ` +
            `read as unscreened rather than as clear.`
          : `Screening is derived from the Chapter 99 notes as published and its ` +
            `reach could not be established for this document. Screen ` +
            `origin-based additional duties independently before filing.`}
      </Text>
      <Text style={{ fontSize: 7.5, marginTop: 2 }}>
        Provisions are {asPublished}
      </Text>
    </View>
  );
}

// --- 4. GRI analysis --------------------------------------------------------

const GRI_ROWS: [keyof Candidate["reasoning"]["gri_analysis"], string][] = [
  ["gri_1", "GRI 1 — Terms of the headings and relative Section or Chapter Notes"],
  ["gri_2", "GRI 2 — Incomplete or unassembled articles; mixtures"],
  ["gri_3", "GRI 3 — Specificity, essential character, last in numerical order"],
  ["gri_4", "GRI 4 — Goods most akin"],
  ["gri_5", "GRI 5 — Cases, containers and packing materials"],
  ["gri_6", "GRI 6 — Comparison at the subheading level"],
  ["additional_us_rules", "Additional U.S. Rules of Interpretation"],
];

function GriSection({ candidate }: { candidate: Candidate }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>BASIS OF CLASSIFICATION</Text>
      <Text style={styles.para}>{candidate.reasoning.justification}</Text>

      {GRI_ROWS.map(([key, label]) => {
        const value = candidate.reasoning.gri_analysis[key];
        if (!value) return null;
        return (
          <View key={key} wrap={false}>
            <Text style={styles.subhead}>{label}</Text>
            <Text style={styles.para}>{value}</Text>
          </View>
        );
      })}

      {candidate.reasoning.notes_applied.length > 0 && (
        <View>
          <Text style={styles.subhead}>Section and Chapter Notes relied on</Text>
          {candidate.reasoning.notes_applied.map((note, index) => (
            <View key={index} style={styles.bulletRow}>
              <Text style={styles.bulletMark}>—</Text>
              <Text style={styles.bulletText}>
                <Text style={{ fontFamily: "Helvetica-Bold" }}>
                  {note.reference}
                </Text>{" "}
                {note.effect}
              </Text>
            </View>
          ))}
        </View>
      )}

      <Text style={{ marginTop: 6, fontSize: 8, color: COLORS.muted }}>
        Stated confidence in this classification: {Math.round(candidate.confidence * 100)}%.
      </Text>
    </View>
  );
}

// --- 5. Assumptions ---------------------------------------------------------

function AssumptionsSection({ view }: { view: DeterminationView }) {
  if (view.assumptions.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>ASSUMPTIONS THIS RESTS ON</Text>
      <Text style={[styles.para, { color: COLORS.muted, fontSize: 8 }]}>
        Facts taken as given that were not stated by the analyst. If any is
        wrong, the classification may change.
      </Text>
      {view.assumptions.map((assumption, index) => (
        <View key={index} style={styles.bulletRow}>
          <Text style={styles.bulletMark}>—</Text>
          <Text style={styles.bulletText}>{assumption}</Text>
        </View>
      ))}
    </View>
  );
}

// --- 6. Alternates considered -----------------------------------------------

/**
 * What the tariff check changed, on the record.
 *
 * Silent when the run was clean, which is the common case — this is not a
 * disclaimer to pad every document with. When it is not silent it is the most
 * important thing on the page: a code the model named that does not exist is
 * the strongest available evidence that the analysis needs a second look, and
 * the analyst who exported this saw it while the reader otherwise would not.
 */
function VerificationSection({ view }: { view: DeterminationView }) {
  const { rejectedCodes, corrections, substitutedRecommendation } =
    view.verification;
  if (
    rejectedCodes.length === 0 &&
    corrections.length === 0 &&
    !substitutedRecommendation
  ) {
    return null;
  }

  // Only corrections that change what would be filed are itemised. Wording
  // differences — a leading tariff number, a trailing colon — are counted
  // rather than listed, so a page full of punctuation notes does not bury a
  // duty rate the model got wrong.
  //
  // A determination recorded before severity existed carries no value at all,
  // and re-issuing its PDF must not quietly drop what the original showed. So
  // the test is for the one severity that may be folded away; anything else,
  // including nothing, is itemised.
  const material = corrections.filter(
    (entry) => entry.severity !== "transcription",
  );
  const transcriptionCount = corrections.length - material.length;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>AUTOMATED CHECKS AGAINST THE TARIFF</Text>
      <Text style={{ fontSize: 8, color: COLORS.muted, marginBottom: 5 }}>
        Every code in this analysis was re-checked against {view.htsusRevision}.
        The following did not match and were corrected or discarded before this
        document was produced.
      </Text>

      {substitutedRecommendation && (
        <View>
          <Text style={styles.subhead}>
            The analysis did not recommend the code it appeared to
          </Text>
          <View style={styles.bulletRow}>
            <Text style={styles.bulletMark}>—</Text>
            <Text style={styles.bulletText}>
              The model recommended{" "}
              <Text style={styles.codeInline}>
                {substitutedRecommendation.modelSaid}
              </Text>
              , which does not exist in {view.htsusRevision}. This application
              substituted{" "}
              <Text style={styles.codeInline}>
                {substitutedRecommendation.using}
              </Text>
              , its best surviving candidate, and that substitution — not the
              model&rsquo;s own conclusion — is what the analyst was shown as the
              recommendation. Weigh the rest of the reasoning accordingly.
            </Text>
          </View>
        </View>
      )}

      {rejectedCodes.length > 0 && (
        <View>
          <Text style={styles.subhead}>Codes discarded</Text>
          {rejectedCodes.map((entry, index) => (
            <View key={index} style={styles.bulletRow}>
              <Text style={styles.bulletMark}>—</Text>
              <Text style={styles.bulletText}>
                <Text style={styles.codeInline}>{entry.code}</Text> — {entry.reason}.
              </Text>
            </View>
          ))}
        </View>
      )}

      {material.length > 0 && (
        <View>
          <Text style={styles.subhead}>Values corrected from the tariff</Text>
          {material.map((entry, index) => (
            <View key={index} style={styles.bulletRow}>
              <Text style={styles.bulletMark}>—</Text>
              <Text style={styles.bulletText}>
                <Text style={styles.codeInline}>{entry.htsCode}</Text>{" "}
                {entry.field}: analysis stated &ldquo;{truncate(entry.modelValue, 120)}
                &rdquo;; the tariff publishes &ldquo;
                {truncate(entry.indexValue, 120)}&rdquo;. The tariff value is used
                above.
              </Text>
            </View>
          ))}
        </View>
      )}

      {transcriptionCount > 0 && (
        <View>
          <Text style={styles.subhead}>Wording normalised</Text>
          <View style={styles.bulletRow}>
            <Text style={styles.bulletMark}>—</Text>
            <Text style={styles.bulletText}>
              {transcriptionCount} description{transcriptionCount === 1 ? "" : "s"}{" "}
              {transcriptionCount === 1 ? "was" : "were"} quoted with different
              punctuation or a leading tariff number. The published wording is
              what appears above. No classification value was affected.
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * Chapter 98 provisions, in their own section and unmistakably not the answer.
 *
 * The determination above states what the product *is*, and that is what a
 * product library carries. A Chapter 98 provision states something about one
 * importation of it — exported and returned, temporarily under bond,
 * originating under USMCA — and the same product can arrive under a different
 * one, or none, next month.
 *
 * Printing it near the determination without that distinction is how a reader
 * months from now ends up treating a shipment-level claim as the product's
 * classification. Hence its own heading, its own sentence saying which is
 * which, and the conditions spelled out for each.
 */
function Chapter98Section({ view }: { view: DeterminationView }) {
  if (view.chapter98Provisions.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>
        CLAIMABLE ON A PARTICULAR ENTRY — NOT PART OF THIS CLASSIFICATION
      </Text>
      <Text style={{ fontSize: 8, color: COLORS.muted, marginBottom: 5 }}>
        These Chapter 98 provisions are claimed alongside the classification
        above on a given import. They turn on the circumstances of that shipment
        rather than on what the product is, so they do not travel with the
        product and are not part of the determination stated above. Each has to
        be established for the entry it is claimed on.
      </Text>
      {view.chapter98Provisions.map((provision, index) => (
        <View key={index} style={styles.bulletRow}>
          <Text style={styles.bulletMark}>—</Text>
          <Text style={styles.bulletText}>
            <Text style={styles.codeInline}>{provision.hts_code}</Text>{" "}
            {provision.provision}.{" "}
            <Text style={{ color: COLORS.muted }}>
              Applies when: {provision.applies_when}
            </Text>
          </Text>
        </View>
      ))}
    </View>
  );
}

function AlternatesSection({ view }: { view: DeterminationView }) {
  if (view.alternates.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>ALTERNATES CONSIDERED AND REJECTED</Text>
      {view.alternates.map((candidate) => (
        <View key={candidate.hts_code} style={styles.alternate} wrap={false}>
          <View style={styles.alternateHead}>
            <Text style={styles.alternateCode}>{candidate.hts_code}</Text>
            <Text style={styles.alternateDesc}>
              {candidate.description_path[candidate.description_path.length - 1] ??
                ""}
            </Text>
          </View>
          <Text style={{ marginTop: 3 }}>
            {candidate.reasoning.why_not_selected ??
              "Ranked lower; no specific rejection rationale was recorded."}
          </Text>
        </View>
      ))}
    </View>
  );
}

// --- 7. Authorities ---------------------------------------------------------

function AuthoritiesSection({ view }: { view: DeterminationView }) {
  const rulings = view.selected.cross_rulings;
  const sources = view.subject.researched?.sources ?? [];
  if (rulings.length === 0 && sources.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>AUTHORITIES AND SOURCES</Text>

      {rulings.length > 0 && (
        <View>
          <Text style={styles.subhead}>CBP rulings (CROSS)</Text>
          <Text style={{ fontSize: 7.5, color: COLORS.muted, marginBottom: 3 }}>
            Cited by the analysis and screened for a valid CBP ruling number and
            link. Not independently retrieved from CROSS — read each ruling
            before relying on it.
          </Text>
          {rulings.map((ruling, index) => (
            <View key={index} style={styles.bulletRow}>
              <Text style={styles.bulletMark}>—</Text>
              <Text style={styles.bulletText}>
                <Text style={{ fontFamily: "Helvetica-Bold" }}>
                  {ruling.ruling_number}
                </Text>{" "}
                {ruling.holding} {ruling.relevance}
                {"\n"}
                <Text style={[styles.link, { fontSize: 7.5 }]}>{ruling.url}</Text>
              </Text>
            </View>
          ))}
        </View>
      )}

      {sources.length > 0 && (
        <View>
          <Text style={styles.subhead}>Product information</Text>
          {sources.map((source, index) => (
            <View key={index} style={styles.bulletRow}>
              <Text style={styles.bulletMark}>—</Text>
              <Text style={styles.bulletText}>
                {source.what_it_supported}
                {"\n"}
                <Text style={[styles.link, { fontSize: 7.5 }]}>{source.url}</Text>
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// --- 8. Disclaimer ----------------------------------------------------------

/**
 * The limitations, stated once and in full.
 *
 * These used to be set at 7pt in a fixed footer repeated on every page. That
 * had two costs and no benefit. The footer ran to eight lines, so it consumed
 * roughly the bottom fifth of every page — which is what pushed the
 * determination itself onto page two with a hand's width of white space above
 * it. And nobody reads eight lines of 7pt grey type printed identically four
 * times; repetition at that size is how a real limitation becomes wallpaper.
 *
 * So it is a section now, at the end, at a size a person can actually read,
 * and every page carries a one-line pointer to it. The text is unchanged.
 */
function ScopeSection() {
  return (
    // Flows rather than forcing a page: on the sample it otherwise claimed a
    // fourth page to hold three paragraphs, and the footer on every page
    // already points here, so it does not need to announce itself.
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>SCOPE AND LIMITATIONS</Text>
      <Text style={styles.para}>
        Advisory work product, machine-generated. The named analyst selected the
        classification from the candidates presented; this document does not
        evidence any further review, and the identity above is self-asserted at
        sign-in and not authenticated. It is not a ruling letter and is not
        binding on U.S. Customs and Border Protection.
      </Text>
      <Text style={styles.para}>
        Scope is tariff classification only — country of origin, valuation, free
        trade agreement eligibility, antidumping and countervailing duty scope,
        quota, and partner government agency requirements were not analysed.
        Chapter 99 additional duties, including Section 301 and Section 232, are
        screened only partially and must be verified independently; this
        document does not establish that none apply.
      </Text>
      <Text style={styles.para}>
        For high-value, high-volume, or genuinely ambiguous merchandise, request
        a binding ruling under 19 CFR Part 177 before entry. Duty rates are as
        published in the tariff edition named above and change frequently;
        confirm currency before filing.
      </Text>
    </View>
  );
}

function Footer() {
  return (
    <View style={styles.footer} fixed>
      <Text style={styles.footerText}>
        Advisory work product, machine-generated — not a ruling letter and not
        binding on CBP. Full scope and limitations at the end of this document.
      </Text>
      <Text
        style={styles.pageNumber}
        render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
      />
    </View>
  );
}

// --- helpers ----------------------------------------------------------------

function formatTimestamp(date: Date): string {
  const iso = date.toISOString().replace("T", " ").slice(0, 19);
  return `${iso} UTC`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
