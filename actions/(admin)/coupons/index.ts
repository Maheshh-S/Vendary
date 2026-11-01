"use server";

import type { Coupon, CouponType } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth-guards";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { runAction } from "@/lib/run-action";
import { parseInput } from "@/lib/validation";
import {
  couponIdSchema,
  couponInputSchema,
  couponUpdateSchema,
  type CouponInput,
} from "@/schemas/admin/coupons/coupon-schema";

const COUPONS_PATH = "/admin/coupons";
const DUPLICATE_CODE_MESSAGE = "A coupon with this code already exists.";

/** Plain, serializable row for the admin table (Decimals become numbers). */
export type CouponAdminView = {
  id: string;
  code: string;
  type: CouponType;
  value: number;
  minSubtotal: number;
  maxDiscount: number | null;
  startsAt: string;
  endsAt: string;
  usageLimit: number | null;
  usedCount: number;
  isActive: boolean;
};

const toView = (coupon: Coupon): CouponAdminView => ({
  id: coupon.id,
  code: coupon.code,
  type: coupon.type,
  value: Number(coupon.value),
  minSubtotal: Number(coupon.minSubtotal),
  maxDiscount: coupon.maxDiscount === null ? null : Number(coupon.maxDiscount),
  startsAt: coupon.startsAt.toISOString(),
  endsAt: coupon.endsAt.toISOString(),
  usageLimit: coupon.usageLimit,
  usedCount: coupon.usedCount,
  isActive: coupon.isActive,
});

const toData = (input: CouponInput) => ({
  code: input.code,
  type: input.type,
  // Stored as fixed decimal strings; the math itself is done in paise.
  value: input.value.toFixed(2),
  minSubtotal: (input.minSubtotal ?? 0).toFixed(2),
  maxDiscount: input.maxDiscount === undefined ? null : input.maxDiscount.toFixed(2),
  startsAt: input.startsAt,
  endsAt: input.endsAt,
  usageLimit: input.usageLimit ?? null,
  isActive: input.isActive,
});

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

/**
 * Every admin coupon mutation is ADMIN-gated, Zod-validated and rate limited.
 * Reads are ADMIN-gated but not limited: the page fetches them on every load.
 */
export const listCoupons = async () =>
  runAction("admin.listCoupons", async () => {
    await requireAdmin();

    const coupons = await prisma.coupon.findMany({ orderBy: { createdAt: "desc" } });
    return coupons.map(toView);
  });

export const createCoupon = async (input: unknown) =>
  runAction("admin.createCoupon", async () => {
    const session = await requireAdmin();

    await enforceRateLimit({
      bucket: "adminMutation",
      subject: session.user.id,
      ...RATE_LIMITS.adminMutation,
    });

    const data = parseInput(couponInputSchema, input);
    try {
      const coupon = await prisma.coupon.create({ data: toData(data) });
      revalidatePath(COUPONS_PATH);
      return { id: coupon.id, code: coupon.code };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError("CONFLICT", DUPLICATE_CODE_MESSAGE);
      }
      throw error;
    }
  });

export const updateCoupon = async (input: unknown) =>
  runAction("admin.updateCoupon", async () => {
    const session = await requireAdmin();

    await enforceRateLimit({
      bucket: "adminMutation",
      subject: session.user.id,
      ...RATE_LIMITS.adminMutation,
    });

    const { id, ...fields } = parseInput(couponUpdateSchema, input);
    const normalized = toData(fields);
    try {
      const updated = await prisma.coupon.updateMany({
        where: { id },
        data: normalized,
      });
      if (updated.count === 0) {
        throw new AppError("NOT_FOUND", "Coupon not found.");
      }
      revalidatePath(COUPONS_PATH);
      return { id, code: normalized.code };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError("CONFLICT", DUPLICATE_CODE_MESSAGE);
      }
      throw error;
    }
  });

export const deactivateCoupon = async (input: unknown) =>
  runAction("admin.deactivateCoupon", async () => {
    const session = await requireAdmin();

    await enforceRateLimit({
      bucket: "adminMutation",
      subject: session.user.id,
      ...RATE_LIMITS.adminMutation,
    });

    const { id } = parseInput(couponIdSchema, input);
    const updated = await prisma.coupon.updateMany({
      where: { id },
      data: { isActive: false },
    });
    if (updated.count === 0) {
      throw new AppError("NOT_FOUND", "Coupon not found.");
    }

    revalidatePath(COUPONS_PATH);
    return { id, isActive: false };
  });
