import { getDocumentProxy, extractText } from "unpdf";
import { notesSectionOf } from "./scripts/sync-htsus";

const targets = ["General Notes", "Chapter 91", "Chapter 23", "Chapter 84", "Chapter 96"];
for (const name of targets) {
  const res = await fetch(
    `https://hts.usitc.gov/reststop/file?release=currentRelease&filename=${encodeURIComponent(name)}`,
    { headers: { "User-Agent": "Dude-E-TariffClassifier/0.1" } },
  );
  const bytes = Buffer.from(await res.arrayBuffer());
  const doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const { text } = await extractText(doc, { mergePages: true });
  const notes = notesSectionOf(text);
  console.log(`\n=== ${name} === full=${text.length} notes=${notes.length}`);
  console.log("  ends: ..." + JSON.stringify(notes.slice(-110)));
  if (name === "General Notes") {
    for (const probe of ["USMCA", "originating", "General Note 4", "General Note 11"]) {
      console.log(`  contains ${probe}:`, notes.includes(probe));
    }
  }
}
