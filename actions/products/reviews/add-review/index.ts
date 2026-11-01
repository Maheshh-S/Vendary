"use server";

import { Prisma, type OrderStatus, type Review } from "@prisma/client";
import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/lib/action-result";
import { requireUser } from "@/lib/auth-guards";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { clientKey } from "@/lib/request-key";
import { runAction } from "@/lib/run-action";
import { parseInput } from "@/lib/validation";
import { AddReviewSchema, type AddReviewInput } from "@/schemas/products/reviews/review-schema";

/** Orders in these states prove the reviewer actually received the product. */
const VERIFIED_PURCHASE_STATUSES: OrderStatus[] = ["confirmed", "shipped", "delivered"];

/**
 * Adds one review for the signed-in user. The unique (userId, productId)
 * constraint is the final duplicate guard; its P2002 is surfaced as CONFLICT
 * instead of leaking a Prisma error.
 */
export const addReview = async (input: AddReviewInput): Promise<ActionResult<Review>> =>
  runAction("products.addReview", async () => {
    const session = await requireUser();

    const { productId, rating, review } = parseInput(AddReviewSchema, input);

    await enforceRateLimit({
      bucket: "addReview",
      subject: await clientKey("addReview", session.user.id),
      limit: RATE_LIMITS.addReview.limit,
      windowMs: RATE_LIMITS.addReview.windowMs,
    });

    // A dangling productId would surface as an opaque foreign-key error.
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) {
      throw new AppError("NOT_FOUND", "Product not found.");
    }

    const purchase = await prisma.orderItem.findFirst({
      where: {
        productId,
        order: {
          userId: session.user.id,
          status: { in: VERIFIED_PURCHASE_STATUSES },
        },
      },
      select: { id: true },
    });

    let createdReview: Review;
    try {
      createdReview = await prisma.review.create({
        data: {
          rating,
          review,
          productId,
          userId: session.user.id,
          verifiedPurchase: purchase !== null,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError("CONFLICT", "You already reviewed this product.");
      }
      throw error;
    }

    revalidatePath(`/products/${productId}`);
    return createdReview;
  });
