import "server-only";

import type { Session } from "next-auth";

import { auth } from "@/auth";
import { AppError } from "./errors";

/** A session whose user (and user id) is guaranteed to be present. */
type AuthenticatedSession = Session & {
  user: NonNullable<Session["user"]> & { id: string };
};

/**
 * Requires an authenticated session, throwing UNAUTHORIZED otherwise.
 * Returns the session with a non-null user id for the caller.
 */
export const requireUser = async (): Promise<AuthenticatedSession> => {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AppError("UNAUTHORIZED", "Please sign in to continue.");
  }
  return session as AuthenticatedSession;
};

/**
 * Requires an ADMIN session. Authentication is checked first so anonymous
 * callers get UNAUTHORIZED and signed-in non-admins get FORBIDDEN.
 */
export const requireAdmin = async (): Promise<AuthenticatedSession> => {
  const session = await requireUser();
  if (session.user.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", "You do not have permission to do that.");
  }
  return session;
};
