/**
 * Is the tariff snapshot on the volume still the one this code would build?
 *
 * A snapshot is not a copy of what USITC published — it is that payload run
 * through the parser, with the results *stored*. `is_reportable` is a column.
 * Description paths and inherited rates are columns. So a change to a rule in
 * `src/lib/hts/parse.ts` changes nothing whatever until a sync runs again.
 *
 * That gap is silent, and it has already cost a release. Making Chapter 98
 * provisions declarable was written, tested, reviewed and deployed — and had no
 * effect, because the snapshot on the volume had been built by the previous
 * rule, the entrypoint re-syncs only when the data directory is *empty*, and
 * nothing compared the data against the code that derived it. The deploy went
 * green and the behaviour did not move.
 *
 * This is the comparison that was missing. Exit 0 means the snapshot was built
 * by the rules this build holds; exit 1 means it was not, and the entrypoint
 * re-syncs in the background.
 *
 * A crash here also exits non-zero and so also triggers a re-sync. That is the
 * right direction to fail in: the cost is a ninety-second background download
 * of data the app already has, against the alternative of serving a tariff
 * derived by rules nobody can identify.
 */

import fs from "node:fs";
import path from "node:path";
import { DERIVATION_VERSION } from "../../src/lib/hts/parse";
import type { HtsusManifest } from "../../src/lib/hts/types";

const MANIFEST_FILENAME = "manifest.json";

function dataDir(): string {
  return process.env.HTSUS_DATA_DIR ?? "./data/htsus";
}

/**
 * Every snapshot directory under the data root, not just the newest.
 *
 * The staleness question is about what the app might serve, and the store picks
 * its directory by its own ordering rules. Checking all of them means the
 * answer does not depend on reimplementing that choice here and getting it
 * subtly different.
 */
function snapshotDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, MANIFEST_FILENAME)));
}

function derivationVersionOf(dir: string): number | null {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(dir, MANIFEST_FILENAME), "utf8"),
  ) as Partial<HtsusManifest>;
  // Absent means the snapshot predates the field, which means it predates the
  // rule change that introduced it. That is stale by definition, not unknown.
  return typeof parsed.derivationVersion === "number"
    ? parsed.derivationVersion
    : null;
}

function main(): void {
  const root = dataDir();
  const dirs = snapshotDirs(root);

  if (dirs.length === 0) {
    // Nothing to compare. The empty-directory case is the entrypoint's to
    // handle and it handles it first, so reaching here means a directory with
    // no readable manifest — a half-finished sync, most likely.
    console.log(`No readable snapshot manifest under ${root}.`);
    process.exit(1);
  }

  const stale: string[] = [];
  for (const dir of dirs) {
    const version = derivationVersionOf(dir);
    if (version !== DERIVATION_VERSION) {
      stale.push(
        `  ${path.basename(dir)}: built by derivation ${version ?? "(unversioned)"}, ` +
          `this build is ${DERIVATION_VERSION}`,
      );
    }
  }

  if (stale.length > 0) {
    console.log("Tariff snapshot predates this build's derivation rules:");
    for (const line of stale) console.log(line);
    process.exit(1);
  }

  console.log(`Snapshot derivation ${DERIVATION_VERSION} matches this build.`);
}

main();
