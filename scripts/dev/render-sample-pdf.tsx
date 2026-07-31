/**
 * Render the sample determination so a style change can be eyeballed.
 *
 *   npm run dev:pdf
 *
 * Uses the same fixture as the PDF tests, so what you look at is what the
 * tests assert on.
 */
import fs from "node:fs";
import path from "node:path";
import { renderToFile } from "@react-pdf/renderer";
import { DeterminationDoc } from "../../src/lib/pdf/DeterminationDoc";
import { sampleDeterminationView } from "../../src/test/determination-fixture";

async function main(): Promise<void> {
  const output = path.resolve(
    process.argv[2] ?? "./data/pdf/sample-determination.pdf",
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });

  await renderToFile(
    <DeterminationDoc view={sampleDeterminationView()} />,
    output,
  );

  console.log(`Wrote ${output}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
