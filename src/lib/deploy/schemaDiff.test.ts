/**
 * The boot guard, against DDL Prisma actually emits.
 *
 * `db push --accept-data-loss` runs on every boot against the live audit
 * database. Every schema change this repository has made is additive, so the
 * flag has never cost anything — but nothing checked, and the first change that
 * is not additive would have destroyed data on signed determinations, printed
 * "applying database schema", and served with health reporting ok.
 *
 * The fixtures below are real output from
 * `prisma migrate diff --from-config-datasource --to-schema … --script` against
 * this schema, not hand-written approximations of it.
 */

import { describe, expect, it } from "vitest";
import { destructiveStatements, statementsOf } from "./schemaDiff";

/** Adding a nullable column — every change this project has shipped. */
const ADDITIVE_DIFF = `
-- AlterTable
ALTER TABLE "Determination" ADD COLUMN "reviewNote" TEXT;
`;

/**
 * Renaming `analystNote`. Prisma has no rename on SQLite, so it rebuilds the
 * table — and the INSERT that repopulates it simply does not carry the old
 * column, which is how the reason every analyst gave for overriding a
 * recommendation would have disappeared from signed determinations.
 */
const RENAME_DIFF = `
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Determination" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewerNote" TEXT
);
INSERT INTO "new_Determination" ("id") SELECT "id" FROM "Determination";
DROP TABLE "Determination";
ALTER TABLE "new_Determination" RENAME TO "Determination";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
`;

describe("statementsOf", () => {
  it("drops Prisma's annotation comments and keeps what executes", () => {
    expect(statementsOf(ADDITIVE_DIFF)).toEqual([
      'ALTER TABLE "Determination" ADD COLUMN "reviewNote" TEXT',
    ]);
  });

  it("reads an empty diff as nothing to do", () => {
    expect(statementsOf("\n-- This is an empty migration.\n")).toEqual([]);
  });
});

describe("destructiveStatements", () => {
  it("lets an added nullable column through", () => {
    expect(destructiveStatements(statementsOf(ADDITIVE_DIFF))).toEqual([]);
  });

  it("catches a table rebuild", () => {
    const flagged = destructiveStatements(statementsOf(RENAME_DIFF));
    expect(flagged).toContain('DROP TABLE "Determination"');
    expect(flagged).toContain(
      'ALTER TABLE "new_Determination" RENAME TO "Determination"',
    );
    // The INSERT is what silently drops the column's contents — it is as much
    // the defect as the DROP is.
    expect(flagged.some((s) => s.startsWith("INSERT INTO"))).toBe(true);
  });

  it("does not wave a rebuild through on its CREATE TABLE alone", () => {
    // `CREATE TABLE "new_Determination"` is additive in isolation and is
    // allowed; the guard must still refuse the block it belongs to.
    expect(destructiveStatements(statementsOf(RENAME_DIFF)).length).toBeGreaterThan(0);
  });

  it("catches a bare column drop", () => {
    expect(
      destructiveStatements(['ALTER TABLE "Determination" DROP COLUMN "analystNote"']),
    ).toEqual(['ALTER TABLE "Determination" DROP COLUMN "analystNote"']);
  });

  it("catches a DELETE dressed up as a migration step", () => {
    expect(destructiveStatements(['DELETE FROM "Determination"'])).toEqual([
      'DELETE FROM "Determination"',
    ]);
  });
});
