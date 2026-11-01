import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { writeOrderEvent } from "@/lib/orders/events";
import { invalidateProductCache } from "@/lib/product-cache";

/**
 * Operational cleanup job, called by an external scheduler with
 * `Authorization: Bearer $CRON_SECRET`.
 *
 * Two safe, idempotent jobs:
 *
 * 1. Abandoned checkout rows: orders that are still `pending`, have no captured
 *    payment (`paymentId: ""`) and are older than 60 minutes are flipped to
 *    `cancelled` with an `order_cancelled` audit event (`actorId: null`,
 *    `metadata.source: "cleanup"`). Pending orders never decremented stock, so
 *    no stock change or customer email is involved. A recorded payment id is
 *    the money path's claim: those rows are never touched here.
 * 2. Stale checkout addresses: `Address` rows with no owning order and older
 *    than 24h. The relation filter is the guard — a snapshot attached to any
 *    order (including cancelled/refunded history) is never deleted.
 *
 * The featured-product cache is dropped afterwards so the storefront reflects
 * the new state. Every mutation is a guarded `updateMany`/`deleteMany`, so a
 * concurrent confirmation or a repeated cron invocation no-ops instead of
 * double-writing. Failures bubble up as 500 so the scheduler retries; reruns
 * are safe.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PENDING_ORDER_TTL_MS = 60 * 60 * 1000;
const STALE_ADDRESS_TTL_MS = 24 * 60 * 60 * 1000;
/** Upper bound per invocation; the next scheduled run drains any remainder. */
const MAX_ORDERS_PER_RUN = 200;
/**
 * Explicit interactive-transaction budget. Without it Prisma applies its
 * 5s-ish default and a large backlog rolls back every claim in the batch; a
 * bounded 30s keeps a slow-but-progressing run together while still failing
 * fast enough for the scheduler's retry to be useful.
 */
const CLEANUP_TRANSACTION_TIMEOUT_MS = 30_000;

type Authorization = "ok" | "unconfigured" | "unauthorized";

const constantTimeEquals = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const authorize = (request: Request): Authorization => {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return "unconfigured";
  }
  const header = request.headers.get("authorization") ?? "";
  return constantTimeEquals(header, `Bearer ${secret}`) ? "ok" : "unauthorized";
};

export type CleanupResult = {
  cancelledOrders: number;
  deletedAddresses: number;
};

/** Cancels the batch and writes one audit event per order actually claimed. */
const cancelStalePendingOrders = async (cutoff: Date): Promise<number> => {
  const stale = await prisma.order.findMany({
    where: {
      status: "pending",
      paymentId: "",
      createdAt: { lt: cutoff },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: MAX_ORDERS_PER_RUN,
  });

  if (stale.length === 0) {
    return 0;
  }

  return prisma.$transaction(
    async (tx) => {
      let cancelled = 0;
      for (const order of stale) {
        // The status/payment guard makes this the claim: a webhook capture or a
        // customer cancel that won the race leaves a zero count and no event.
        const claimed = await tx.order.updateMany({
          where: { id: order.id, status: "pending", paymentId: "" },
          data: { status: "cancelled" },
        });
        if (claimed.count === 0) {
          continue;
        }
        await writeOrderEvent(tx, {
          orderId: order.id,
          type: "order_cancelled",
          fromStatus: "pending",
          toStatus: "cancelled",
          actorId: null,
          metadata: { source: "cleanup" },
        });
        cancelled += 1;
      }
      return cancelled;
    },
    // Bounded explicitly: the batch is capped at MAX_ORDERS_PER_RUN, and a
    // backlog that still overruns must fail the run (the scheduler retries)
    // rather than hold locks until Prisma's much longer default timeout.
    { timeout: CLEANUP_TRANSACTION_TIMEOUT_MS }
  );
};

const deleteStaleAddresses = async (cutoff: Date): Promise<number> => {
  const result = await prisma.address.deleteMany({
    where: {
      // Any order reference (including cancelled/refunded) protects the
      // immutable snapshot.
      order: { is: null },
      createdAt: { lt: cutoff },
    },
  });
  return result.count;
};

const runCleanup = async (): Promise<CleanupResult> => {
  const startedAt = Date.now();
  const now = startedAt;

  const cancelledOrders = await cancelStalePendingOrders(new Date(now - PENDING_ORDER_TTL_MS));
  const deletedAddresses = await deleteStaleAddresses(new Date(now - STALE_ADDRESS_TTL_MS));

  // Cheap and unconditional: a Redis outage is swallowed by the helper.
  await invalidateProductCache();

  logger.info("cleanup_completed", {
    action: "cron.cleanup",
    durationMs: Date.now() - startedAt,
    cancelledOrders,
    deletedAddresses,
  });

  return { cancelledOrders, deletedAddresses };
};

const handle = async (request: Request): Promise<NextResponse> => {
  const authorization = authorize(request);

  if (authorization === "unconfigured") {
    return NextResponse.json(
      { error: "Cleanup is not configured (CRON_SECRET missing)" },
      { status: 501 }
    );
  }
  if (authorization === "unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await runCleanup());
  } catch (error) {
    // Non-2xx makes the scheduler retry; reruns are idempotent.
    logger.error("cleanup_failed", { action: "cron.cleanup", error });
    return NextResponse.json({ error: "Cleanup failed" }, { status: 500 });
  }
};

/**
 * POST is the canonical trigger; GET is accepted because several hosted cron
 * schedulers (e.g. Vercel) only issue GET. Both require the bearer secret and
 * are equally idempotent.
 */
export const POST = handle;
export const GET = handle;
