import * as z from "zod"

import { isAllowedImageUrl } from "@/lib/images"

/**
 * Avatar URLs are rendered by `next/image`, whose hosts are pinned in
 * `next.config.ts`. Refusing unknown hosts here keeps a saved profile from
 * breaking the header on the next render.
 */
const avatarUrlSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .max(500, "Avatar URL is too long")
    .url("Enter a valid avatar URL")
    .refine(isAllowedImageUrl, "Avatar must be hosted on an allowed image host")
    .optional()
)

export const ProfileSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, "First name is required")
    .max(60, "First name is too long"),
  lastName: z
    .string()
    .trim()
    .min(1, "Last name is required")
    .max(60, "Last name is too long"),
  avatarUrl: avatarUrlSchema,
})

/**
 * Password change. The 72-character ceiling matches bcrypt's input limit; the
 * action additionally verifies the current password against the stored hash
 * and refuses a new password that matches it.
 */
export const ChangePasswordSchema = z.object({
  currentPassword: z
    .string()
    .min(1, "Current password is required")
    .max(72, "Current password is too long"),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters long")
    .max(72, "Password cannot exceed 72 characters"),
})

export type ProfileInput = z.infer<typeof ProfileSchema>
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>
