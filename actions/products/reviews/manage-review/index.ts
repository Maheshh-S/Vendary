"use server";

import type { Review } from "@prisma/client";
import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/lib/action-result";
import { requireUser } from "@/lib/auth-guards";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { runAction } from "@/lib/run-action";
import { parseInput } from "@/lib/validation";
import {
  ReviewIdSchema,
  UpdateReviewSchema,
  type UpdateReviewInput,
} from "@/schemas/products/reviews/review-schema";

/**
 * Edits the signed-in user's own review. Ownership is part of the lookup, so
 * another user's review id is indistinguishable from a missing one.
 */
export const updateReview = async (input: UpdateReviewInput): Promise<ActionResult<Review>> =>
  runAction("products.updateReview", async () => {
    const session = await requireUser();
    const { id, rating, review } = parseInput(UpdateReviewSchema, input);

    const existing = await prisma.review.findFirst({
      where: { id, userId: session.user.id },
      select: { id: true, productId: true },
    });
    if (!existing) {
      throw new AppError("NOT_FOUND", "Review not found.");
    }

    const updated = await prisma.review.update({
      where: { id: existing.id },
      data: { rating, review },
    });

    revalidatePath(`/products/${existing.productId}`);
    return updated;
  });

/**
 * Deletes the signed-in user's own review. `deleteMany` with both predicates
 * is the ownership check and the delete in one round trip.
 */
export const deleteReview = async (reviewId: string) =>
  runAction("products.deleteReview", async () => {
    const session = await requireUser();
    const id = parseInput(ReviewIdSchema, reviewId);

    const existing = await prisma.review.findFirst({
      where: { id, userId: session.user.id },
      select: { productId: true },
    });
    if (!existing) {
      throw new AppError("NOT_FOUND", "Review not found.");
    }

    const result = await prisma.review.deleteMany({
      where: { id, userId: session.user.id },
    });
    if (result.count === 0) {
      throw new AppError("NOT_FOUND", "Review not found.");
    }

    revalidatePath(`/products/${existing.productId}`);
    return { id };
  });
