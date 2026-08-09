/**
 * Guards the deploy workflow's pre-flight checks.
 *
 * The Prisma client is generated code and `prisma/generated/` is gitignored, so
 * a fresh checkout does not have it. Every type that comes from the database is
 * then missing, which surfaces as a module error in `src/lib/db.ts` plus a
 * scatter of implicit-any errors in files that have nothing wrong with them —
 * reading like several unrelated problems rather than one missing step.
 *
 * That is not hypothetical. The deploy workflow's check step was written
 * without `prisma generate` and failed on its first ever run, months after it
 * was added, because until then the app had only ever been deployed through
 * Fly's web UI. Nothing catches this locally: a developer machine has the
 * generated client sitting there from the last `db push`, so the check passes
 * for everyone who has already run the app and fails only in CI.
 *
 * These tests read the workflow file and assert the ordering holds.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOWS = path.join(process.cwd(), ".github", "workflows");

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(WORKFLOWS, name), "utf8");
}

describe("deploy workflow", () => {
  const deploy = readWorkflow("deploy.yml");

  it("generates the Prisma client before typechecking", () => {
    const generate = deploy.indexOf("npx prisma generate");
    const typecheck = deploy.indexOf("npx tsc --noEmit");

    expect(generate).toBeGreaterThan(-1);
    expect(typecheck).toBeGreaterThan(-1);
    // Order matters, not mere presence: generating afterwards would leave the
    // typecheck reading types that do not exist yet.
    expect(generate).toBeLessThan(typecheck);
  });

  it("still gates the deploy on the full check suite", () => {
    // The value of the workflow over a hand-run deploy is that a broken build
    // cannot reach production. Dropping one of these to make a red run green
    // is the tempting fix and the wrong one.
    for (const command of ["npm ci", "npx tsc --noEmit", "npx eslint .", "npx vitest run"]) {
      expect(deploy).toContain(command);
    }
  });

  it("checks the code before touching Fly", () => {
    const check = deploy.indexOf("npx vitest run");
    const flyctl = deploy.indexOf("setup-flyctl");

    expect(check).toBeLessThan(flyctl);
  });

  it("checks the Fly token before any command that needs it", () => {
    // Without this, the first flyctl call is `flyctl status` inside the
    // app-creation step. It fails for want of credentials, the step concludes
    // the app does not exist, and the error blames a name collision or a
    // scoped token — sending you to look at Fly rather than at this
    // repository's settings. That happened, and cost a deploy.
    const tokenCheck = deploy.indexOf("Check the Fly token is present");
    const firstFlyctlCall = deploy.indexOf("flyctl status");

    expect(tokenCheck).toBeGreaterThan(-1);
    expect(tokenCheck).toBeLessThan(firstFlyctlCall);
  });

  it("does not demand the Anthropic key when the app already has it", () => {
    // Requiring it in GitHub too would mean the same credential in two places.
    // The deploy should only insist when it is genuinely set nowhere.
    expect(deploy).toContain("already set on the app; leaving it alone");
  });
});

describe("ops workflow", () => {
  const ops = readWorkflow("ops.yml");

  it("only offers actions the job actually implements", () => {
    // A dropdown entry with no matching step is a button that appears to work
    // and silently does nothing, which is worse than a missing button.
    const options = ops
      .slice(ops.indexOf("options:"), ops.indexOf("confirm:"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim());

    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(ops).toContain(`inputs.action == '${option}'`);
    }
  });

  it("guards the one action that changes anything", () => {
    // A restart drops any analysis in flight, and runs here take minutes.
    expect(ops).toContain("Confirm restart");
    expect(ops).toContain("inputs.confirm");
  });
});
