import "server-only";

import type { Prisma } from "@prisma/client";

/**
 * Releases a coupon claimed by an unpaid order. Called only from inside the
 * transaction that successfully cancels a `pending` order, so the decrement and
 * the redemption delete commit (or roll back) with the cancel.
 *
 * Paid orders keep their redemption forever: the discount was actually given.
 * `usedCount > 0` guards against an inflated count if the redemption was
 * already released by another claim (a no-op instead of a negative counter).
 */
export const releaseCouponForOrder = async (
  tx: Prisma.TransactionClient,
  orderId: string
): Promise<string | null> => {
  const redemption = await tx.couponRedemption.findUnique({
    where: { orderId },
    select: { id: true, couponId: true },
  });
  if (!redemption) {
    return null;
  }

  await tx.coupon.updateMany({
    where: { id: redemption.couponId, usedCount: { gt: 0 } },
    data: { usedCount: { decrement: 1 } },
  });
  await tx.couponRedemption.deleteMany({ where: { id: redemption.id } });

  return redemption.couponId;
};
