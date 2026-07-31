import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { config } from "../config";

export const SESSION_COOKIE = "dude_e_session";

export interface AnalystSession {
  /** Analyst row id. */
  id: string;
  name: string;
  email: string;
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(config.sessionSecret);
}

export async function signSession(session: AnalystSession): Promise<string> {
  return new SignJWT({ name: session.name, email: session.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.id)
    .setIssuedAt()
    .setExpirationTime(`${config.sessionTtlHours}h`)
    .sign(secretKey());
}

export async function verifySession(
  token: string,
): Promise<AnalystSession | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.email !== "string"
    ) {
      return null;
    }
    return { id: payload.sub, name: payload.name, email: payload.email };
  } catch {
    return null;
  }
}

/** Read the current analyst from the request cookie, or null. */
export async function getSession(): Promise<AnalystSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? verifySession(token) : null;
}

/**
 * Read the current analyst or throw. Used by routes that write provenance —
 * an unattributed determination is not something this app should ever produce.
 */
export async function requireSession(): Promise<AnalystSession> {
  const session = await getSession();
  if (!session) throw new UnauthenticatedError();
  return session;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Not signed in.");
    this.name = "UnauthenticatedError";
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} as const;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export interface SignInInput {
  name: string;
  email: string;
}

export type SignInValidation =
  | { ok: true; value: SignInInput }
  | { ok: false; errors: Partial<Record<keyof SignInInput, string>> };

/**
 * Deliberately permissive on shape, strict on emptiness. The point of this
 * gate is attribution, not access control — but an artifact attributed to
 * "  " or "a@b" helps nobody, so both fields must be substantive.
 */
export function validateSignIn(raw: {
  name?: unknown;
  email?: unknown;
}): SignInValidation {
  const errors: Partial<Record<keyof SignInInput, string>> = {};

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const email = typeof raw.email === "string" ? raw.email.trim() : "";

  if (name.length < 2) {
    errors.name = "Enter your full name as it should appear on determinations.";
  } else if (name.length > 120) {
    errors.name = "Name is too long.";
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    errors.email = "Enter a valid work email address.";
  } else if (email.length > 200) {
    errors.email = "Email is too long.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, email: email.toLowerCase() } };
}
