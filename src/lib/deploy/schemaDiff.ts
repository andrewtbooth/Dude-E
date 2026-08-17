/**
 * Reading the DDL `prisma db push` is about to run, and deciding whether it is
 * safe to run it unattended.
 *
 * Separate from the boot script because the boot script needs a live database
 * and this needs a string, and because a guard nobody can test is not much of a
 * guard. See `scripts/deploy/check-schema-additive.ts` for why this exists at
 * all.
 */

/**
 * Statements that only ever add.
 *
 * SQLite has no `ALTER COLUMN`, so Prisma implements a rename, a type change or
 * a new NOT NULL constraint as create-copy-drop-rename against a temporary
 * table — its `RedefineTables` block. `CREATE TABLE "new_Foo"` is allowed
 * through here, but the `INSERT INTO`, `DROP TABLE` and `ALTER TABLE ... RENAME
 * TO` that follow it are not, so a redefine is still caught. Matching on the
 * destructive statements rather than on the block keeps the rule simple and
 * fails toward refusing.
 */
const ADDITIVE = [
  /^ALTER TABLE\s+"?\w+"?\s+ADD COLUMN\b/i,
  /^CREATE TABLE\b/i,
  /^CREATE (UNIQUE )?INDEX\b/i,
  /^PRAGMA\b/i,
];

/** Split a Prisma `migrate diff --script` payload into executable statements. */
export function statementsOf(ddl: string): string[] {
  return ddl
    .split("\n")
    .map((line) => line.trim())
    // Prisma annotates steps as SQL comments; the statements are what run.
    .filter((line) => line.length > 0 && !line.startsWith("--"))
    .join(" ")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** The statements that would do something other than add. Empty means safe. */
export function destructiveStatements(statements: string[]): string[] {
  return statements.filter(
    (statement) => !ADDITIVE.some((pattern) => pattern.test(statement)),
  );
}
