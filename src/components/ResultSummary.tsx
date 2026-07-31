"use client";

import type { ClassificationRun } from "@/lib/agent/classify";

export function ResultSummary({ run }: { run: ClassificationRun }) {
  const { result, verification } = run;

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

      {verification.corrections.length > 0 && (
        <Advisory tone="warn" title="Corrected against the tariff">
          <p>
            These values were replaced with what the published schedule
            actually says.
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {verification.corrections.map((correction, index) => (
              <li key={index}>
                <span className="hts-code">{correction.htsCode}</span>{" "}
                {correction.field}: model said &ldquo;{correction.modelValue}
                &rdquo;, tariff says &ldquo;{correction.indexValue}&rdquo;
              </li>
            ))}
          </ul>
        </Advisory>
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
        </Advisory>
      )}
    </section>
  );
}

function StatusPill({ status }: { status: "needs_more_info" | "complete" }) {
  return status === "complete" ? (
    <span className="rounded bg-[var(--ok-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--ok)]">
      Analysis complete
    </span>
  ) : (
    <span className="rounded bg-[var(--info-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--info)]">
      More information needed
    </span>
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

  return (
    <div className={`rounded-lg border px-4 py-3 ${styles}`}>
      <h3 className="text-xs font-semibold uppercase tracking-wider">{title}</h3>
      <div className="mt-1.5 text-sm text-[var(--text-secondary)]">
        {children}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
