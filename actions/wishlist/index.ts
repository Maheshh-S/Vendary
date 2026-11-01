"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth-guards";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { runAction } from "@/lib/run-action";
import { parseInput } from "@/lib/validation";

const WISHLIST_PATH = "/wishlist";
const WISHLIST_TOGGLE_BUCKET = "wishlistToggle";

// NOTE: kept module-private (not exported) — "use server" modules may only
// export async functions.
const WISHLIST_INPUT = z.object({
  productId: z.string().min(1).max(64),
});

/** Prisma unique-constraint violation (concurrent add of the same pair). */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

export type WishlistItemView = {
  id: string;
  productId: string;
  name: string;
  thumbnail: string | null;
  /** Rupees, matching the rest of the catalog display surface. */
  price: number;
  availability: "IN_STOCK" | "OUT_OF_STOCK" | "PRE_ORDER";
  stockQty: number;
  addedAt: string;
};

/**
 * Adds or removes the signed-in user's saved product, returning the resulting
 * state. `deleteMany` is the toggle's claim: of two concurrent clicks exactly
 * one removes, and a create that loses the unique race means the row already
 * exists (idempotent "added") instead of surfacing an internal error.
 *
 * Deliberately uncached: the result is user-specific and must never be shared
 * between sessions.
 */
export const toggleWishlist = async (productId: string) =>
  runAction("wishlist.toggle", async () => {
    const session = await requireUser();

    await enforceRateLimit({
      bucket: WISHLIST_TOGGLE_BUCKET,
      subject: session.user.id,
      ...RATE_LIMITS.wishlistToggle,
    });

    const input = parseInput(WISHLIST_INPUT, { productId });

    const product = await prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true },
    });
    if (!product) {
      throw new AppError("NOT_FOUND", "Product not found.");
    }

    const removed = await prisma.wishlistItem.deleteMany({
      where: { userId: session.user.id, productId: input.productId },
    });
    if (removed.count > 0) {
      revalidatePath(WISHLIST_PATH);
      return { added: false };
    }

    try {
      await prisma.wishlistItem.create({
        data: { userId: session.user.id, productId: input.productId },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Another click/tab added it first; the requested end state holds.
        revalidatePath(WISHLIST_PATH);
        return { added: true };
      }
      throw error;
    }

    revalidatePath(WISHLIST_PATH);
    return { added: true };
  });

/** The signed-in user's saved products, newest first, with live availability. */
export const getWishlist = async () =>
  runAction("wishlist.list", async () => {
    const session = await requireUser();

    const rows = await prisma.wishlistItem.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            thumbnail: true,
            price: true,
            availability: true,
            stockQty: true,
          },
        },
      },
    });

    return rows.map<WishlistItemView>((row) => ({
      id: row.id,
      productId: row.product.id,
      name: row.product.name,
      thumbnail: row.product.thumbnail,
      price: Number(row.product.price),
      availability: row.product.availability,
      stockQty: row.product.stockQty,
      addedAt: row.createdAt.toISOString(),
    }));
  });
