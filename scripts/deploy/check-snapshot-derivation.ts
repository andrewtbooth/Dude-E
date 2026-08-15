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
import { resolveLatestRevisionDir } from "../../src/lib/hts/store";
import type { HtsusManifest } from "../../src/lib/hts/types";

const MANIFEST_FILENAME = "manifest.json";

function dataDir(): string {
  return process.env.HTSUS_DATA_DIR ?? "./data/htsus";
}

/**
 * The one snapshot the app would actually serve.
 *
 * This used to check every directory under the data root and fail if any of
 * them mismatched — on the reasoning that checking all of them avoids
 * reimplementing the store's choice and getting it subtly different. The
 * reasoning was right and the effect was not, because syncs do not prune: a
 * new revision lands beside the old ones, `fly.toml` explicitly sizes the
 * volume to keep a previous revision, and every retired directory keeps its
 * original derivation stamp forever.
 *
 * So the first re-sync after a rule change satisfies nothing. The freshly
 * built snapshot is current, the retired ones next to it are not, the check
 * exits 1 on every boot from then on, and the entrypoint downloads sixty
 * megabytes it already has — once per boot, for the life of the volume. The
 * "snapshot present and current" branch becomes unreachable, and a signal
 * added to catch a real problem now fires unconditionally.
 *
 * Asking the store which directory it would open keeps the original intent
 * (no reimplemented ordering) without judging snapshots nothing will read.
 */
function activeSnapshotDir(root: string): string | null {
  if (!fs.existsSync(root)) return null;
  try {
    const dir = resolveLatestRevisionDir(root);
    return fs.existsSync(path.join(dir, MANIFEST_FILENAME)) ? dir : null;
  } catch {
    // No readable snapshot at all. The entrypoint handles the empty case
    // first, so this is a half-finished sync.
    return null;
  }
}

function derivationVersionOf(dir: string): number | null {
  // A manifest mid-write is the case this script's own reasoning anticipates,
  // and an uncaught SyntaxError here prints a Node stack into the boot log —
  // which reads like the container crashed rather than like a snapshot that
  // needs re-syncing. Same outcome, said plainly.
  let parsed: Partial<HtsusManifest>;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(dir, MANIFEST_FILENAME), "utf8"),
    ) as Partial<HtsusManifest>;
  } catch {
    return null;
  }
  // Absent means the snapshot predates the field, which means it predates the
  // rule change that introduced it. That is stale by definition, not unknown.
  return typeof parsed.derivationVersion === "number"
    ? parsed.derivationVersion
    : null;
}

function main(): void {
  const root = dataDir();
  const dir = activeSnapshotDir(root);

  if (dir === null) {
    // Nothing to compare. The empty-directory case is the entrypoint's to
    // handle and it handles it first, so reaching here means no readable
    // manifest — a half-finished sync, most likely.
    console.log(`No readable snapshot manifest under ${root}.`);
    process.exit(1);
  }

  const version = derivationVersionOf(dir);
  if (version !== DERIVATION_VERSION) {
    console.log(
      `Tariff snapshot predates this build's derivation rules:\n` +
        `  ${path.basename(dir)}: built by derivation ` +
        `${version ?? "(unversioned)"}, this build is ${DERIVATION_VERSION}`,
    );
    process.exit(1);
  }

  console.log(
    `Snapshot derivation ${DERIVATION_VERSION} matches this build ` +
      `(${path.basename(dir)}).`,
  );
}

main();
