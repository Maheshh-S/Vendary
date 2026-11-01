import "server-only";

import type { Prisma } from "@prisma/client";

/**
 * True when this customer already holds a redemption for the coupon and its
 * order is an abandoned checkout: still `pending` with no payment proof. Such
 * a redemption counts toward `usedCount`, so an exhausted coupon may still be
 * usable by the same customer — the charge transaction releases the old
 * redemption before claiming the new one.
 *
 * Shared by the cart quote so the quote does not keep payment disabled for the
 * exact retry the charge path would accept.
 */
export const callerHoldsAbandonedRedemption = async (
  db: Pick<Prisma.TransactionClient, "couponRedemption">,
  couponId: string,
  userId: string
): Promise<boolean> => {
  const own = await db.couponRedemption.findUnique({
    where: { couponId_userId: { couponId, userId } },
    select: { order: { select: { status: true, paymentId: true } } },
  });
  return own?.order.status === "pending" && own.order.paymentId === "";
};

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
