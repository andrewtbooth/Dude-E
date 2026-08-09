/**
 * Refuse to apply the schema when the existing audit database cannot hold it.
 *
 * `Determination.analysisId` became unique so two in-flight exports cannot mint
 * two signed conclusions for one piece of work. A database written before that
 * constraint existed may already contain such a pair — the popup-blocked export
 * button made it easy to produce one by clicking twice.
 *
 * `prisma db push` cannot create the index over those rows. It fails, the
 * entrypoint exits, and the machine boots and dies reporting an index error
 * rather than the data problem behind it. This runs first and names the rows.
 *
 * It deliberately deletes nothing. These are determination records: each may
 * correspond to a document somebody already holds. Which of a duplicated pair
 * is the decision is a judgement about the work, not a call a boot script gets
 * to make.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

interface DuplicateRow {
  analysisId: string;
  n: number;
  ids: string;
}

function databasePath(): string {
  const url = process.env.DATABASE_URL ?? "file:./prisma/dude-e.db";
  return path.resolve(url.replace(/^file:/, ""));
}

function main(): number {
  const file = databasePath();

  // A fresh volume has nothing to conflict with — the common case on a first
  // deploy. Nothing to check, and nothing worth saying about it.
  if (!fs.existsSync(file)) return 0;

  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true });
  } catch (error) {
    // An unreadable database is a real problem but not this one. Let `db push`
    // produce its own diagnosis rather than guessing here.
    const message = error instanceof Error ? error.message : String(error);
    console.log(`==> uniqueness pre-check skipped: ${message}`);
    return 0;
  }

  try {
    const tableExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Determination'",
      )
      .get();
    if (!tableExists) return 0;

    const duplicates = db
      .prepare(
        `SELECT analysisId, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
           FROM Determination
          GROUP BY analysisId
         HAVING n > 1
          ORDER BY n DESC`,
      )
      .all() as DuplicateRow[];

    if (duplicates.length === 0) return 0;

    console.error("==> FATAL: the audit database has duplicate determinations.");
    console.error("");
    console.error(
      "    Determination.analysisId is now unique: one analysis yields one",
    );
    console.error(
      "    signed conclusion. These rows predate that and block the index:",
    );
    console.error("");
    for (const row of duplicates) {
      console.error(`      analysis ${row.analysisId} -> ${row.n} determinations`);
      console.error(`        ${row.ids.split(",").join("\n        ")}`);
    }
    console.error("");
    console.error(
      "    Nothing has been deleted. Each may correspond to a document someone",
    );
    console.error(
      "    already holds, so which one is the decision is your call.",
    );
    console.error("");
    console.error("    To inspect them:");
    console.error(
      '      fly ssh console -C "npx tsx scripts/deploy/list-duplicate-determinations.ts"',
    );
    console.error("");
    console.error(
      "    If these are trial artifacts and none was issued to anyone, deleting",
    );
    console.error("    the later row of each pair is safe.");
    return 1;
  } finally {
    db.close();
  }
}

process.exit(main());
