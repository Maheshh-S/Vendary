import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

import { loginWith } from "./helpers";
import { isLocalOrCiDatabase, serverEnv } from "./env";

/**
 * Task 2.3/2.2 — profile edit and address book. A dedicated user is created
 * through Prisma (local/CI database only) so the seeded demo admin is never
 * mutated; the user and its cascaded rows are removed in afterAll.
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
const PASSWORD = "AccountE2e1";
const ACCOUNT = {
  email: `e2e-account-${suffix}@vendary.test`,
  password: PASSWORD,
};
let userId = "";

test.describe("account settings", () => {
  test.beforeAll(async () => {
    test.skip(
      !connectionString || !fixtureDbSafe,
      "Prisma fixtures only run against a local or CI database"
    );

    const user = await prisma.user.create({
      data: {
        email: ACCOUNT.email,
        password: await bcrypt.hash(PASSWORD, 10),
        emailVerified: new Date(),
        firstName: "E2E Account",
        lastName: "User",
        name: "E2E Account User",
        role: "USER",
      },
    });
    userId = user.id;
  });

  test.afterAll(async () => {
    if (!connectionString || !fixtureDbSafe) return;

    if (userId) {
      await prisma.savedAddress.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma.$disconnect();
  });

  test("updates the profile name and shows it in the header", async ({ page }) => {
    await loginWith(page, ACCOUNT);
    await page.goto("/account");

    await expect(page.getByTestId("header-user-name")).toHaveText("E2E Account User");

    await page.getByLabel("First name").fill("Renamed");
    await page.getByLabel("Last name").fill("Shopper");
    await page.getByRole("button", { name: "Save profile" }).click();

    await expect(page.getByText("Profile updated")).toBeVisible();
    // The header reads the name from the database on the next request.
    await expect(page.getByTestId("header-user-name")).toHaveText("Renamed Shopper");

    const stored = await prisma.user.findUnique({ where: { id: userId } });
    expect(stored).toMatchObject({
      firstName: "Renamed",
      lastName: "Shopper",
      name: "Renamed Shopper",
    });
  });

  test("adds saved addresses and moves the default", async ({ page }) => {
    await loginWith(page, ACCOUNT);
    await page.goto("/account/addresses");

    const fillAddress = async (label: string, line1: string, postalCode: string) => {
      await page.getByLabel("Label (optional)").fill(label);
      await page.getByLabel("First name").fill("Asha");
      await page.getByLabel("Last name").fill("Rao");
      await page.getByLabel("Phone number").fill("9876543210");
      await page.getByLabel("Postal code").fill(postalCode);
      await page.getByLabel("Address", { exact: true }).fill(line1);
      await page.getByLabel("Area/Neighborhood").fill("Indiranagar");
      await page.getByLabel("State").fill("Karnataka");
      await page.getByRole("button", { name: "Save address" }).click();
    };

    await fillAddress("Home", "12 MG Road, Apartment 4B", "560038");
    const homeCard = page.getByTestId("saved-address").filter({ hasText: "Home" });
    await expect(homeCard).toBeVisible();
    // The first address becomes the default automatically.
    await expect(homeCard.getByText("Default", { exact: true })).toBeVisible();

    await fillAddress("Office", "45 Residency Road, Floor 2", "560025");
    const officeCard = page.getByTestId("saved-address").filter({ hasText: "Office" });
    await expect(officeCard).toBeVisible();
    await expect(officeCard.getByText("Default", { exact: true })).toHaveCount(0);

    await officeCard.getByRole("button", { name: "Set default" }).click();
    await expect(officeCard.getByText("Default", { exact: true })).toBeVisible();
    await expect(homeCard.getByText("Default", { exact: true })).toHaveCount(0);

    const stored = await prisma.savedAddress.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    expect(stored).toHaveLength(2);
    expect(stored.filter((row) => row.isDefault)).toHaveLength(1);
    expect(stored.find((row) => row.isDefault)?.label).toBe("Office");
  });

  test("edits an address and clears label, line 2 and landmark", async ({ page }) => {
    await loginWith(page, ACCOUNT);
    await page.goto("/account/addresses");

    await page.getByLabel("Label (optional)").fill("Clearing");
    await page.getByLabel("First name").fill("Asha");
    await page.getByLabel("Last name").fill("Rao");
    await page.getByLabel("Phone number").fill("9876543210");
    await page.getByLabel("Postal code").fill("560001");
    await page.getByLabel("Address", { exact: true }).fill("9 Clearance Lane");
    await page.getByLabel("Address line 2 (optional)").fill("Behind the temple");
    await page.getByLabel("Area/Neighborhood").fill("Indiranagar");
    await page.getByLabel("Landmark (optional)").fill("Opposite the school");
    await page.getByLabel("State").fill("Karnataka");
    await page.getByRole("button", { name: "Save address" }).click();

    const card = page
      .getByTestId("saved-address")
      .filter({ hasText: "9 Clearance Lane" });
    await expect(card).toBeVisible();
    await expect(card.getByText("Behind the temple")).toBeVisible();
    await expect(card.getByText("Opposite the school")).toBeVisible();

    await card.getByRole("button", { name: "Edit" }).click();
    // The always-present "Add an address" form shares every label, so scope
    // the edits to the card that opened the edit form.
    const editForm = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: "Edit address" }) });
    await editForm.getByLabel("Label (optional)").fill("");
    await editForm.getByLabel("Address line 2 (optional)").fill("");
    await editForm.getByLabel("Landmark (optional)").fill("");
    await editForm.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByText("Address updated")).toBeVisible();
    const updatedCard = page
      .getByTestId("saved-address")
      .filter({ hasText: "9 Clearance Lane" });
    await expect(updatedCard).toBeVisible();
    await expect(updatedCard.getByText("Clearing", { exact: true })).toHaveCount(0);
    await expect(updatedCard.getByText("Behind the temple")).toHaveCount(0);
    await expect(updatedCard.getByText("Opposite the school")).toHaveCount(0);
    // The card title falls back to the recipient name once the label is gone.
    await expect(updatedCard.getByText("Asha Rao", { exact: true })).toBeVisible();

    const stored = await prisma.savedAddress.findFirst({
      where: { userId, line1: "9 Clearance Lane" },
    });
    expect(stored).toMatchObject({ label: null, line2: null, landmark: null });
  });
});
