/**
 * Guards the container's boot sequence against flag drift.
 *
 * The entrypoint runs before anything can report a problem: it applies the
 * schema, then hands off to the server. If one of its commands rejects a flag,
 * `set -e` aborts the script and the container dies without ever listening.
 * The platform's only signal is "deployed successfully but some machines could
 * be failing" — which points at infrastructure, not at a CLI argument.
 *
 * That is exactly what `--skip-generate` did after the Prisma 7 upgrade: the
 * flag was removed because `db push` no longer generates a client, so passing
 * it exits 1. Nothing in the build catches it. `npm run build` doesn't run the
 * entrypoint, and a typecheck cannot see inside a shell script.
 *
 * So this test reads the flags out of the entrypoint and asks the *installed*
 * CLI whether it still accepts them. It fails on upgrade, in CI, rather than on
 * a machine nobody is watching.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = path.join(process.cwd(), "docker-entrypoint.sh");

interface Invocation {
  /** e.g. ["db", "push"] */
  subcommand: string[];
  flags: string[];
}

/**
 * Pull `prisma <subcommand> --flags` invocations out of the shell script.
 *
 * Deliberately simple: it matches the literal command lines the script runs,
 * which is all the entrypoint contains. If that stops being true the parser
 * finds nothing, and the "found some" assertion below fails rather than the
 * suite silently verifying an empty set.
 */
function parsePrismaInvocations(script: string): Invocation[] {
  const invocations: Invocation[] = [];

  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;

    const match = line.match(/npx prisma ([a-z]+(?: [a-z]+)?)((?: --[a-z-]+)*)/);
    if (!match) continue;

    invocations.push({
      subcommand: match[1].split(" "),
      flags: match[2].trim().split(/\s+/).filter(Boolean),
    });
  }

  return invocations;
}

function helpText(subcommand: string[]): string {
  return execFileSync("npx", ["prisma", ...subcommand, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("docker-entrypoint.sh", () => {
  const script = fs.readFileSync(ENTRYPOINT, "utf8");
  const invocations = parsePrismaInvocations(script);

  it("invokes prisma at least once, so the checks below mean something", () => {
    expect(invocations.length).toBeGreaterThan(0);
  });

  it.each(invocations)(
    "prisma $subcommand accepts every flag the entrypoint passes",
    ({ subcommand, flags }) => {
      const help = helpText(subcommand);
      for (const flag of flags) {
        expect(
          help,
          `${flag} is not accepted by \`prisma ${subcommand.join(" ")}\` in ` +
            `the installed version. The entrypoint would exit 1 at boot and ` +
            `the container would never serve.`,
        ).toContain(flag);
      }
    },
    30_000,
  );

  it("aborts rather than serving when the schema cannot be applied", () => {
    // A schema-less app is worse than a dead one here: /api/health reports on
    // the tariff snapshot and never touches the database, so the platform
    // would see a healthy machine that fails every real request.
    expect(script).toMatch(/exit 1/);
  });

  it("backgrounds the tariff sync so the port opens inside the grace period", () => {
    // The download takes about ninety seconds. Foregrounding it means the
    // health check fails before the server exists.
    expect(script).toMatch(/\)\s*&/);
  });
});
