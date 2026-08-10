/**
 * A ten-digit HTSUS number, set so its structure is visible.
 *
 * A classification number is not one number. `8507.60.00.20` is a heading
 * (8507), a subheading (.60), a tariff-rate line (.00) and a statistical
 * suffix (.20), and an analyst comparing two candidates is almost always
 * comparing them at one specific level — "same subheading, different stat
 * suffix" is a different conversation from "different chapter entirely".
 * Printed as an undifferentiated string, that structure has to be counted out
 * by eye every time.
 *
 * So the segments are spaced slightly apart and the leading four digits carry
 * more weight. It stays one selectable, copyable string — the separators are
 * real characters in the text, not pseudo-elements — because the first thing
 * anyone does with a code is paste it into something else.
 */
export function HtsCode({
  code,
  size = "base",
  className = "",
}: {
  code: string;
  /** `lead` is for the determination itself; `base` for candidates; `sm` inline. */
  size?: "lead" | "base" | "sm";
  className?: string;
}) {
  const sizing = {
    lead: "text-2xl font-semibold sm:text-3xl",
    base: "text-base font-semibold",
    sm: "text-xs",
  }[size];

  const segments = code.split(".");

  return (
    <span className={`hts-code inline-flex items-baseline ${sizing} ${className}`}>
      {segments.map((segment, index) => (
        <span key={index} className={index === 0 ? "" : "ml-[0.15em]"}>
          {index > 0 && (
            // Kept in the text so a copy carries the dots, but dimmed so the
            // digits are what the eye lands on.
            <span className="text-[var(--text-muted)]">.</span>
          )}
          {segment}
        </span>
      ))}
    </span>
  );
}

/**
 * The heading-level prefix of a code, for grouping and comparison.
 *
 * Exported alongside the component because the places that show a code are
 * usually also the places that want to say two codes are related.
 */
export function headingOf(code: string): string {
  return code.replace(/\D/g, "").slice(0, 4);
}
