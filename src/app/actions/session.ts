"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
  validateSignIn,
} from "@/lib/auth/session";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";

/**
 * Sign-in as a Server Action rather than a client fetch.
 *
 * This form is the first thing a user touches, and a client-side handler has a
 * window before hydration where a click falls through to a native submit — in
 * this case a GET that would put the analyst's name and email into the URL,
 * browser history, and any access log in front of the app. A Server Action
 * submits as a POST with or without JavaScript, so that window does not exist.
 */

export interface SignInState {
  errors?: Partial<Record<"name" | "email", string>>;
  formError?: string;
}

export async function signInAction(
  _prevState: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const validated = validateSignIn({
    name: formData.get("name"),
    email: formData.get("email"),
  });

  if (!validated.ok) return { errors: validated.errors };

  const { name, email } = validated.value;

  try {
    const analyst = await prisma.analyst.upsert({
      where: { email },
      // Name is refreshed on each sign-in so a correction propagates forward.
      // Determinations already decided keep the name they were stamped with,
      // because each one copies it at decision time rather than joining to
      // this row — see `analystName` on the Determination model.
      update: { name, lastSeenAt: new Date() },
      create: { name, email },
    });

    const token = await signSession({
      id: analyst.id,
      name: analyst.name,
      email: analyst.email,
    });

    (await cookies()).set(SESSION_COOKIE, token, {
      ...sessionCookieOptions,
      maxAge: config.sessionTtlHours * 60 * 60,
    });
  } catch (error) {
    return {
      formError:
        error instanceof Error
          ? `Could not start a session: ${error.message}`
          : "Could not start a session.",
    };
  }

  // Outside the try: redirect() signals by throwing, and catching it here
  // would turn a successful sign-in into a reported failure.
  redirect("/analyze");
}

export async function signOutAction(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, "", {
    ...sessionCookieOptions,
    maxAge: 0,
  });
  redirect("/");
}
