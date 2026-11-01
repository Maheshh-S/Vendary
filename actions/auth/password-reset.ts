"use server";

import bcrypt from "bcryptjs";

import { getPasswordResetTokenByToken } from "@/actions/token";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { sendPasswordResetEmail } from "@/lib/mail";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { clientKey } from "@/lib/request-key";
import { runAction } from "@/lib/run-action";
import { generatePasswordResetToken } from "@/lib/token";
import { parseInput } from "@/lib/validation";
import {
  ForgotPasswordSchema,
  PASSWORD_RESET_REQUEST_MESSAGE,
  ResetPasswordSchema,
} from "@/schemas/auth/password-reset-schema";

const INVALID_RESET_TOKEN_MESSAGE =
  "This reset link is invalid or has expired. Please request a new one.";

/**
 * Starts the reset flow. Rate limits are counted before the account lookup so
 * unknown addresses consume the same budget and reveal nothing; prior tokens
 * are invalidated by `generatePasswordResetToken` (one live token per email).
 */
export const requestPasswordReset = async (email: string) =>
  runAction("auth.requestPasswordReset", async () => {
    const { email: normalizedEmail } = parseInput(ForgotPasswordSchema, { email });

    // One IP budget first, then per-address: an attacker rotating addresses
    // still hits the IP ceiling; a single address can only mail 3/hour.
    await enforceRateLimit({
      bucket: "passwordResetIp",
      subject: await clientKey("passwordReset"),
      ...RATE_LIMITS.passwordResetIp,
    });
    await enforceRateLimit({
      bucket: "passwordResetEmail",
      subject: normalizedEmail,
      ...RATE_LIMITS.passwordResetEmail,
    });

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, password: true },
    });

    // Unknown address or passwordless (OAuth-only) account: no token, no mail,
    // same response.
    if (!user?.email || !user.password) {
      return { message: PASSWORD_RESET_REQUEST_MESSAGE };
    }

    const resetToken = await generatePasswordResetToken(user.email);
    await sendPasswordResetEmail(user.email, resetToken.token);

    return { message: PASSWORD_RESET_REQUEST_MESSAGE };
  });

/**
 * Consumes a reset token exactly once. The delete inside the transaction is
 * the claim: two concurrent submissions of the same token can both pass the
 * read above, but only one deletes the row and updates the password.
 */
export const resetPassword = async (token: string, password: string) =>
  runAction("auth.resetPassword", async () => {
    const input = parseInput(ResetPasswordSchema, { token, password });

    const resetToken = await getPasswordResetTokenByToken(input.token);
    if (!resetToken || new Date(resetToken.expires).getTime() <= Date.now()) {
      throw new AppError("VALIDATION", INVALID_RESET_TOKEN_MESSAGE);
    }

    const user = await prisma.user.findUnique({
      where: { email: resetToken.email },
      select: { id: true },
    });
    if (!user) {
      throw new AppError("VALIDATION", INVALID_RESET_TOKEN_MESSAGE);
    }

    const hashedPassword = await bcrypt.hash(input.password, 10);

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.deleteMany({
        where: { id: resetToken.id },
      });
      if (claimed.count === 0) {
        throw new AppError("VALIDATION", INVALID_RESET_TOKEN_MESSAGE);
      }

      await tx.user.update({
        where: { id: user.id },
        data: { password: hashedPassword },
      });

      // Token hygiene: no other outstanding links for this address survive.
      await tx.passwordResetToken.deleteMany({
        where: { email: resetToken.email },
      });
    });

    console.info(
      JSON.stringify({ level: "info", event: "password_reset_completed", userId: user.id })
    );

    return { reset: true as const };
  });
