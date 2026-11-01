"use server"

import bcrypt from "bcryptjs"
import { revalidatePath } from "next/cache"

import { requireUser } from "@/lib/auth-guards"
import { prisma } from "@/lib/db/prisma"
import { AppError } from "@/lib/errors"
import { runAction } from "@/lib/run-action"
import { parseInput } from "@/lib/validation"
import {
  ChangePasswordSchema,
  ProfileSchema,
  type ChangePasswordInput,
  type ProfileInput,
} from "@/schemas/account/profile-schema"

const ACCOUNT_PATH = "/account"

/**
 * Updates the display name and avatar. The combined `name` column is kept in
 * sync because review lists render it, while `image`/`profilePic` cover the
 * header and review avatars respectively.
 *
 * Session note: names come from the database on every Auth.js JWT callback, so
 * the header refreshes on the next request. Changing a password cannot revoke
 * other devices' JWT sessions — they stay valid until expiry (documented in
 * the account UI).
 */
export const updateProfile = async (input: ProfileInput) =>
  runAction("account.updateProfile", async () => {
    const session = await requireUser()
    const data = parseInput(ProfileSchema, input)

    const updated = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        name: `${data.firstName} ${data.lastName}`.trim(),
        profilePic: data.avatarUrl ?? null,
        image: data.avatarUrl ?? null,
      },
      select: { id: true, firstName: true, lastName: true, profilePic: true },
    })

    // Audit trail without PII: the id and the fields that changed, no values.
    console.info(
      JSON.stringify({
        level: "info",
        event: "account_profile_updated",
        userId: session.user.id,
        fields: ["firstName", "lastName", "avatar"],
      })
    )

    revalidatePath(ACCOUNT_PATH)
    return updated
  })

/**
 * Changes the password after verifying the current one. Password reset tokens
 * are cleared as part of the same transaction. Other devices' JWT sessions are
 * deliberately untouched (Auth.js JWT sessions are not revocable per device);
 * they remain valid until their expiry.
 */
export const changePassword = async (input: ChangePasswordInput) =>
  runAction("account.changePassword", async () => {
    const session = await requireUser()
    const data = parseInput(ChangePasswordSchema, input)

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, email: true, password: true },
    })

    if (!user?.password) {
      throw new AppError(
        "VALIDATION",
        "Password sign-in is not enabled for this account. Use your sign-in provider to manage the password."
      )
    }

    const currentMatches = await bcrypt.compare(data.currentPassword, user.password)
    if (!currentMatches) {
      throw new AppError("VALIDATION", "Current password is incorrect.", {
        currentPassword: ["Current password is incorrect."],
      })
    }

    // `currentMatches` plus equality against the stored hash is the authority;
    // schema-level equality would also work, but the hash is the truth.
    if (await bcrypt.compare(data.newPassword, user.password)) {
      throw new AppError("VALIDATION", "New password must be different from your current password.", {
        newPassword: ["New password must be different from your current password."],
      })
    }

    const hashedPassword = await bcrypt.hash(data.newPassword, 10)

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword },
      }),
      prisma.passwordResetToken.deleteMany({ where: { email: user.email ?? "" } }),
    ])

    console.info(
      JSON.stringify({
        level: "info",
        event: "account_password_changed",
        userId: user.id,
      })
    )

    revalidatePath(ACCOUNT_PATH)
    return { changed: true as const }
  })
