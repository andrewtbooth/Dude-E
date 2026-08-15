/**
 * Is the pending schema change safe to apply unattended?
 *
 * `prisma db push --accept-data-loss` runs on every boot, against a live audit
 * database, with no diff printed and no operator watching. For every change
 * this repository has made so far that is fine — they have all been additive —
 * but the flag says out loud that it will not stop for data loss, and nothing
 * else does either. Rename `analystNote` to `reviewerNote` and Prisma sees a
 * drop and an add: the next boot silently destroys the reason every analyst
 * gave for overriding a recommendation, on signed determinations, prints
 * "applying database schema", and serves. `/api/health` would say `ok`.
 *
 * So the destructive case stops being routine and starts being loud. This
 * generates the DDL Prisma is about to run and refuses the boot if any
 * statement is not additive. A deliberate destructive migration is still
 * possible — it just has to be an explicit act rather than a side effect of a
 * schema edit nobody diffed.
 *
 * Exit 0: every statement adds. Exit 1: something drops, renames, or rewrites,
 * and a human needs to look.
 */

import { execFileSync } from "node:child_process";
import { destructiveStatements, statementsOf } from "../../src/lib/deploy/schemaDiff";

function pendingDdl(): string {
  // --from-config-datasource reads the live database; --to-schema is the schema
  // this build carries. That pair is precisely what `db push` will reconcile a
  // moment later. (Prisma 7 renamed --to-schema-datamodel to --to-schema; the
  // old flag exits non-zero, which this script correctly treats as a refusal
  // rather than as permission.)
  return execFileSync(
    "npx",
    [
      "prisma",
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      "prisma/schema.prisma",
      "--script",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function main(): void {
  let ddl: string;
  try {
    ddl = pendingDdl();
  } catch (error) {
    // Failing to read the diff is not a licence to apply it blind. This is the
    // one check whose whole purpose is to be certain before a destructive
    // statement runs unattended, so an uncertain answer is a refusal.
    console.log(
      "Could not determine the pending schema change; refusing to apply it " +
        "unattended.\n" +
        String(error instanceof Error ? error.message : error),
    );
    process.exit(1);
  }

  const statements = statementsOf(ddl);

  if (statements.length === 0) {
    console.log("Schema is already in sync; nothing to apply.");
    return;
  }

  const destructive = destructiveStatements(statements);

  console.log(`Pending schema change (${statements.length} statement(s)):`);
  for (const statement of statements) console.log(`  ${statement};`);

  if (destructive.length > 0) {
    console.log(
      "\nRefusing to apply this unattended: the statements below are not " +
        "purely additive, and `db push --accept-data-loss` would run them " +
        "against the live audit database without stopping.",
    );
    for (const statement of destructive) console.log(`  ${statement};`);
    console.log(
      "\nBack the volume up and apply it deliberately, or land the change as " +
        "an additive step first (add the new column, backfill, drop the old " +
        "one in a later release).",
    );
    process.exit(1);
  }

  console.log("\nAll statements are additive.");
}

main();
