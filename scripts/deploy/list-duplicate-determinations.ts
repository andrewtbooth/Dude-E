/**
 * Show duplicate determinations in full, so a human can decide which is real.
 *
 * The boot check names the rows and refuses; this prints enough of each to tell
 * them apart — who decided, when, which code, whether a PDF was ever issued.
 * A determination whose `pdfSha256` is set has been rendered at least once,
 * which usually means a document left the building.
 *
 *   fly ssh console -C "npx tsx scripts/deploy/list-duplicate-determinations.ts"
 */

import { prisma } from "../../src/lib/db";

async function main(): Promise<void> {
  const rows = await prisma.determination.findMany({
    orderBy: [{ analysisId: "asc" }, { decidedAt: "asc" }],
    select: {
      id: true,
      analysisId: true,
      selectedHtsCode: true,
      analystName: true,
      decidedAt: true,
      pdfSha256: true,
      analystNote: true,
    },
  });

  const byAnalysis = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byAnalysis.get(row.analysisId) ?? [];
    group.push(row);
    byAnalysis.set(row.analysisId, group);
  }

  const duplicated = [...byAnalysis.entries()].filter(([, g]) => g.length > 1);

  if (duplicated.length === 0) {
    console.log("No analysis has more than one determination.");
    return;
  }

  console.log(
    `${duplicated.length} analysis/analyses have more than one determination.\n`,
  );

  for (const [analysisId, group] of duplicated) {
    console.log(`analysis ${analysisId}`);
    for (const [index, row] of group.entries()) {
      console.log(
        `  ${index === 0 ? "first " : "later "} ${row.id}` +
          `  ${row.selectedHtsCode}` +
          `  ${row.decidedAt.toISOString()}` +
          `  ${row.analystName}`,
      );
      console.log(
        `          PDF issued: ${
          row.pdfSha256
            ? `yes (${row.pdfSha256.slice(0, 12)}…) — a copy may be in circulation`
            : "no"
        }`,
      );
      if (row.analystNote) console.log(`          note: ${row.analystNote}`);
    }
    console.log("");
  }

  console.log(
    "A row with no PDF issued was never rendered and is the safer one to drop.",
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
