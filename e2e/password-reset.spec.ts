import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

import { loginWith } from "./helpers";
import { isLocalOrCiDatabase, serverEnv } from "./env";

/**
 * Task 2.1 — password reset. The email transport is disabled in e2e
 * (`EMAIL_FROM=""`), so the token is written through Prisma (local/CI database
 * only) exactly as the mail link would carry it. Cleanup removes the user and
 * any tokens.
 */

const connectionString = serverEnv("DATABASE_URL");
const fixtureDbSafe = isLocalOrCiDatabase(connectionString);
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: connectionString || "postgresql://invalid:invalid@localhost:5432/invalid",
    },
  },
});

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const EMAIL = `e2e-reset-${suffix}@vendary.test`;
const OLD_PASSWORD = "OldPassword1";
const NEW_PASSWORD = "NewPassword2";
let userId = "";

test.describe("password reset", () => {
  test.beforeAll(async () => {
    test.skip(
      !connectionString || !fixtureDbSafe,
      "Prisma fixtures only run against a local or CI database"
    );

    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        password: await bcrypt.hash(OLD_PASSWORD, 10),
        emailVerified: new Date(),
        firstName: "Reset",
        lastName: "Tester",
        name: "Reset Tester",
        role: "USER",
      },
    });
    userId = user.id;
  });

  test.afterAll(async () => {
    if (!connectionString || !fixtureDbSafe) return;

    await prisma.passwordResetToken.deleteMany({ where: { email: EMAIL } });
    if (userId) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma.$disconnect();
  });

  test("resets once through the page and the new password signs in", async ({ page }) => {
    const token = `e2e-reset-token-${suffix}`;
    await prisma.passwordResetToken.create({
      data: {
        email: EMAIL,
        token,
        expires: new Date(Date.now() + 60 * 60_000),
      },
    });

    await page.goto(`/password/reset?token=${token}`);
    await page.getByLabel("New password").fill(NEW_PASSWORD);
    await page.getByLabel("Confirm password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Update password" }).click();

    await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();
    expect(await prisma.passwordResetToken.count({ where: { token } })).toBe(0);

    // The same link is consumed: replaying it shows the invalid-link message.
    await page.goto(`/password/reset?token=${token}`);
    await page.getByLabel("New password").fill("AnotherPassword3");
    await page.getByLabel("Confirm password").fill("AnotherPassword3");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText(/invalid or has expired/i)).toBeVisible();

    // The reset actually changed the bcrypt hash.
    const stored = await prisma.user.findUnique({ where: { id: userId } });
    expect(stored?.password).not.toBeNull();
    expect(await bcrypt.compare(NEW_PASSWORD, stored?.password ?? "")).toBe(true);

    // And the new credentials sign in (the old password would fail).
    await loginWith(page, { email: EMAIL, password: NEW_PASSWORD });
  });

  test("forgot-password returns the same message for an unknown address", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email Address").fill(`missing-${suffix}@vendary.test`);
    await page.getByRole("button", { name: "Send reset link" }).click();

    await expect(page.getByRole("status")).toContainText(
      "If an account exists for that email"
    );
  });
});
