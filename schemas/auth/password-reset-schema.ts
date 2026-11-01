import * as z from "zod";

/**
 * Password reset boundaries.
 *
 * Emails are trimmed and lowercased so the same address always maps to one
 * account. Passwords are capped at 72 characters: bcrypt silently truncates
 * beyond that, and a reset must not accept a password whose tail is ignored.
 */
export const ForgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required")
    .email("Enter a valid email address")
    .max(254, "Email is too long"),
});

export const ResetPasswordSchema = z.object({
  token: z.string().trim().min(1, "Reset token is required").max(128, "Reset token is invalid"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters long")
    .max(72, "Password cannot exceed 72 characters"),
});

/**
 * The response is identical for known and unknown addresses (and for
 * OAuth-only accounts without a password), so the endpoint cannot be used to
 * enumerate users.
 */
export const PASSWORD_RESET_REQUEST_MESSAGE =
  "If an account exists for that email, we've sent password reset instructions.";

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
