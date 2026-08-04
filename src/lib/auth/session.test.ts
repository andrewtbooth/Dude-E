import { beforeAll, describe, expect, it } from "vitest";
import { signSession, validateSignIn, verifySession } from "./session";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-not-used-anywhere-real-0123456789";
});

describe("validateSignIn", () => {
  it("accepts a normal name and work email, normalising the email", () => {
    const result = validateSignIn({
      name: "  Dana Okafor ",
      email: "  Dana.Okafor@Example.COM ",
    });
    expect(result).toEqual({
      ok: true,
      value: { name: "Dana Okafor", email: "dana.okafor@example.com" },
    });
  });

  it("rejects blank or single-character names", () => {
    expect(validateSignIn({ name: "   ", email: "a@b.co" }).ok).toBe(false);
    expect(validateSignIn({ name: "D", email: "a@b.co" }).ok).toBe(false);
  });

  it("rejects malformed emails", () => {
    for (const email of ["", "nope", "a@b", "a b@c.co", "@example.com"]) {
      const result = validateSignIn({ name: "Dana Okafor", email });
      expect(result.ok, `expected ${JSON.stringify(email)} to be rejected`).toBe(
        false,
      );
    }
  });

  it("reports which field failed", () => {
    const result = validateSignIn({ name: "", email: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toBeDefined();
      expect(result.errors.email).toBeDefined();
    }
  });

  it("rejects non-string input rather than coercing it", () => {
    expect(validateSignIn({ name: 42, email: null }).ok).toBe(false);
    expect(validateSignIn({}).ok).toBe(false);
  });
});

describe("session tokens", () => {
  const analyst = {
    id: "an_123",
    name: "Dana Okafor",
    email: "dana.okafor@example.com",
  };

  it("round-trips an analyst identity", async () => {
    const token = await signSession(analyst);
    expect(await verifySession(token)).toEqual(analyst);
  });

  it("rejects a tampered token", async () => {
    const token = await signSession(analyst);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "an_999", name: "Someone Else", email: "x@y.co" }),
    ).toString("base64url");

    expect(await verifySession(`${header}.${forged}.${signature}`)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifySession("")).toBeNull();
    expect(await verifySession("not.a.jwt")).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession(analyst);
    process.env.SESSION_SECRET = "a-completely-different-secret-value-9876543210";
    expect(await verifySession(token)).toBeNull();
    process.env.SESSION_SECRET = "test-secret-not-used-anywhere-real-0123456789";
  });
});
