"use client";

import type { ClassificationRun } from "@/lib/agent/classify";
import type { Refinement } from "@/lib/agent/schema";
import { StrengthenAnalysis } from "./StrengthenAnalysis";

export function ResultSummary({
  run,
  onStrengthen,
  busy = false,
  strengthenSlot,
}: {
  run: ClassificationRun;
  /**
   * Supply the facts the analysis said would firm it up, and re-run.
   *
   * Absent on a view that cannot start a run, in which case the gaps stay
   * visible and stay read-only — which is what every view did before this,
   * including the ones that could perfectly well have offered the round.
   */
  onStrengthen?: (refinements: Refinement[]) => void;
  busy?: boolean;
  /** Pre-rendered equivalent, for a server-component caller. */
  strengthenSlot?: React.ReactNode;
}) {
  const { result, verification } = run;

  // A correction is only worth an advisory when it changes what the analyst
  // would file. Transcription differences — a leading HTS number the model
  // kept in the description, a trailing colon it dropped — are noise at the
  // top of the page, so they sit behind a disclosure instead.
  //
  // Partitioned on "is it transcription" rather than "is it material" on
  // purpose: runs recorded before severity existed carry neither value, and
  // a correction with no severity has to keep being shown. Testing for the
  // quiet case means an unrecognised one stays loud.
  const transcription = verification.corrections.filter(
    (correction) => correction.severity === "transcription",
  );
  const material = verification.corrections.filter(
    (correction) => correction.severity !== "transcription",
  );

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusPill status={result.status} />
          <span className="text-xs text-[var(--text-muted)]">
            {result.htsus_revision} · {run.model} · {run.effort} effort ·{" "}
            {formatDuration(run.durationMs)}
          </span>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
          {result.summary}
        </p>

        {result.researched_product && (
          <ResearchedProduct product={result.researched_product} />
        )}
      </div>

      {verification.rejectedCodes.length > 0 && (
        <Advisory tone="danger" title="Codes dropped in verification">
          <p>
            The model returned {verification.rejectedCodes.length} code
            {verification.rejectedCodes.length === 1 ? "" : "s"} that could not
            be confirmed against {result.htsus_revision}. They were removed
            rather than shown to you.
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {verification.rejectedCodes.map((rejected) => (
              <li key={rejected.code}>
                <span className="hts-code">{rejected.code}</span> —{" "}
                {rejected.reason}
              </li>
            ))}
          </ul>
        </Advisory>
      )}

      {material.length > 0 && (
        <Advisory tone="warn" title="Corrected against the tariff">
          <p>
            These values were replaced with what the published schedule
            actually says.
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {material.map((correction, index) => (
              <li key={index}>
                <span className="hts-code">{correction.htsCode}</span>{" "}
                {correction.field}: model said &ldquo;{correction.modelValue}
                &rdquo;, tariff says &ldquo;{correction.indexValue}&rdquo;
              </li>
            ))}
          </ul>
        </Advisory>
      )}

      {transcription.length > 0 && (
        <details className="rounded-lg border border-[var(--border)] px-4 py-3">
          <summary className="tap-target cursor-pointer text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {transcription.length} wording difference
            {transcription.length === 1 ? "" : "s"} normalised
          </summary>
          <div className="mt-1.5 text-sm text-[var(--text-secondary)]">
            <p>
              The model quoted these descriptions with different punctuation or
              a leading tariff number. The published wording is what is shown
              and exported.
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {transcription.map((correction, index) => (
                <li key={index}>
                  <span className="hts-code">{correction.htsCode}</span>{" "}
                  {correction.field}: model said &ldquo;{correction.modelValue}
                  &rdquo;, tariff says &ldquo;{correction.indexValue}&rdquo;
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

      {result.assumptions.length > 0 && (
        <Advisory tone="info" title="Assumptions this analysis rests on">
          <ul className="space-y-0.5">
            {result.assumptions.map((assumption, index) => (
              <li key={index}>{assumption}</li>
            ))}
          </ul>
        </Advisory>
      )}

      {result.info_that_would_raise_confidence.length > 0 && (
        <Advisory tone="info" title="Would raise confidence">
          <ul className="space-y-0.5">
            {result.info_that_would_raise_confidence.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          {/*
            The list used to end here. An analyst could be told exactly what
            would have strengthened the classification and had no way to supply
            any of it short of retyping the description as a new analysis —
            and the determination said nothing about the gaps at all.
          */}
          {strengthenSlot ??
            (onStrengthen && (
              <StrengthenAnalysis
                items={result.info_that_would_raise_confidence}
                busy={busy}
                onSubmit={onStrengthen}
              />
            ))}
        </Advisory>
      )}
    </section>
  );
}

/**
 * The run's outcome as a struck mark rather than a filled pill.
 *
 * A filled chip in a semantic colour is what every dashboard uses for
 * everything, and it reads as decoration. An outlined mark reads as something
 * applied to a document — which is what this is: a statement about whether the
 * analysis reached a conclusion, on a page that becomes a record.
 */
function StatusPill({ status }: { status: "needs_more_info" | "complete" }) {
  return status === "complete" ? (
    <span className="stamp text-[var(--ok)]">Analysis complete</span>
  ) : (
    <span className="stamp text-[var(--info)]">More information needed</span>
  );
}

function ResearchedProduct({
  product,
}: {
  product: NonNullable<ClassificationRun["result"]["researched_product"]>;
}) {
  return (
    <div className="mt-4 rounded-md bg-[var(--surface-2)] p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        What the part appears to be
      </h3>

      <dl className="mt-2 space-y-1.5 text-sm">
        {product.manufacturer && (
          <Row label="Manufacturer" value={product.manufacturer} />
        )}
        {product.product_name && (
          <Row label="Product" value={product.product_name} />
        )}
        {product.materials.length > 0 && (
          <Row label="Materials" value={product.materials.join(", ")} />
        )}
        {product.function && <Row label="Function" value={product.function} />}
        {product.end_use && <Row label="End use" value={product.end_use} />}
      </dl>

      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        {product.summary}
      </p>

      {product.vendor_published_codes.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-medium text-[var(--text-primary)]">
            Codes published by the vendor
          </h4>
          <p className="text-xs text-[var(--text-muted)]">
            Evidence, not an answer — vendor codes are often stale or for
            another country&rsquo;s tariff.
          </p>
          <ul className="mt-1 space-y-0.5">
            {product.vendor_published_codes.map((entry, index) => (
              <li key={index} className="text-xs text-[var(--text-secondary)]">
                <span className="hts-code">{entry.code}</span> ({entry.kind}) —{" "}
                <span className="text-[var(--text-muted)]">{entry.source}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {product.sources.length > 0 && (
        <ul className="mt-3 space-y-0.5">
          {product.sources.map((source, index) => (
            <li key={index} className="text-xs">
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent)] underline-offset-2 hover:underline"
              >
                {source.url}
              </a>
              <span className="text-[var(--text-muted)]">
                {" "}
                — {source.what_it_supported}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-xs text-[var(--text-muted)]">{label}</dt>
      <dd className="text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}

function Advisory({
  tone,
  title,
  children,
}: {
  tone: "info" | "warn" | "danger";
  title: string;
  children: React.ReactNode;
}) {
  const styles = {
    info: "border-[var(--info)] bg-[var(--info-subtle)] text-[var(--info)]",
    warn: "border-[var(--warn)] bg-[var(--warn-subtle)] text-[var(--warn)]",
    danger: "border-[var(--danger)] bg-[var(--danger-subtle)] text-[var(--danger)]",
  }[tone];

  // A named region rather than an anonymous div. These carry the disclosures —
  // corrections, assumptions, the gaps the analysis wants closed — and a screen
  // reader had no way to jump to them or to tell one from the next. Named the
  // same way the rest of the app names its regions, so they land in the same
  // landmark list.
  return (
    <section
      aria-label={title}
      className={`rounded-lg border px-4 py-3 ${styles}`}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wider">{title}</h3>
      <div className="mt-1.5 text-sm text-[var(--text-secondary)]">
        {children}
      </div>
    </section>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
