import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
  validateSignIn,
} from "@/lib/auth/session";
import { config } from "@/lib/config";

export const runtime = "nodejs";

/** Sign in: record (or refresh) the analyst and issue a session cookie. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Expected a JSON body." },
      { status: 400 },
    );
  }

  const validated = validateSignIn(body as { name?: unknown; email?: unknown });
  if (!validated.ok) {
    return NextResponse.json({ errors: validated.errors }, { status: 400 });
  }

  const { name, email } = validated.value;

  const analyst = await prisma.analyst.upsert({
    where: { email },
    // Name is refreshed on each sign-in so a correction propagates to future
    // determinations. Past determinations keep the name they were stamped with.
    update: { name, lastSeenAt: new Date() },
    create: { name, email },
  });

  const token = await signSession({
    id: analyst.id,
    name: analyst.name,
    email: analyst.email,
  });

  const response = NextResponse.json({
    analyst: { id: analyst.id, name: analyst.name, email: analyst.email },
  });
  response.cookies.set(SESSION_COOKIE, token, {
    ...sessionCookieOptions,
    maxAge: config.sessionTtlHours * 60 * 60,
  });
  return response;
}

/** Sign out. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    ...sessionCookieOptions,
    maxAge: 0,
  });
  return response;
}
