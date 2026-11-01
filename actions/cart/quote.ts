"use server";

import type { ActionResult } from "@/lib/action-result";
import {
  computeCouponDiscount,
  couponRejectionMessage,
  INVALID_COUPON_MESSAGE,
} from "@/lib/coupons";
import { prisma } from "@/lib/db/prisma";
import { computeTotalsWithDiscount } from "@/lib/money";
import { runAction } from "@/lib/run-action";
import { parseInput } from "@/lib/validation";
import {
  cartQuoteSchema,
  couponCodeSchema,
  type CartQuote,
  type CartQuoteIssue,
  type CartQuoteLine,
} from "@/schemas/cart/quote-schema";

/**
 * Authoritative cart quote. Given only product ids and quantities, it re-prices
 * every line from the database and reports availability/stock problems in the
 * same pass. The cart and checkout pages use it for display and to block
 * payment on stale or unavailable items; `createRazorpayOrder` still re-prices
 * independently (the quote is advisory, never a charge input).
 *
 * Coupons are validated here only to make the display honest. An invalid code
 * yields `couponError` (with zero discount) instead of failing the quote; the
 * checkout gate treats it as blocking, and the charge path revalidates from
 * scratch so a stale quote can never buy a discount.
 *
 * Totals include every line with a known price (unavailable lines keep their
 * listed price; missing lines contribute 0) so the display stays coherent while
 * the blocking issue explains why payment is disabled.
 */
export const getCartQuote = async (
  lineItems: unknown,
  couponCode?: unknown
): Promise<ActionResult<CartQuote>> =>
  runAction("cart.quote", async () => {
    const lines = parseInput(cartQuoteSchema, lineItems);
    const code = parseInput(couponCodeSchema, couponCode);

    const products = await prisma.product.findMany({
      where: { id: { in: lines.map((line) => line.productId) } },
      select: {
        id: true,
        name: true,
        thumbnail: true,
        price: true,
        availability: true,
        stockQty: true,
      },
    });
    const productById = new Map(products.map((product) => [product.id, product]));

    const quoteLines: CartQuoteLine[] = lines.map(({ productId, quantity }) => {
      const product = productById.get(productId);
      if (!product) {
        return {
          productId,
          name: "",
          image: null,
          unitPaise: 0,
          quantity,
          availability: "OUT_OF_STOCK",
          stockQty: 0,
          issue: "MISSING" as CartQuoteIssue,
        };
      }

      const issue: CartQuoteIssue =
        product.availability !== "IN_STOCK"
          ? "OUT_OF_STOCK"
          : product.stockQty < quantity
            ? "INSUFFICIENT_STOCK"
            : null;

      return {
        productId,
        name: product.name,
        image: product.thumbnail,
        // Stored prices are rupee Decimals; the wire is integer paise.
        unitPaise: Math.round(Number(product.price) * 100),
        quantity,
        availability: product.availability,
        stockQty: product.stockQty,
        issue,
      };
    });

    const subtotalPaise = quoteLines.reduce((acc, line) => acc + line.unitPaise * line.quantity, 0);

    let discountPaise = 0;
    let couponError: string | null = null;
    if (code) {
      const coupon = await prisma.coupon.findUnique({ where: { code } });
      if (!coupon) {
        couponError = INVALID_COUPON_MESSAGE;
      } else {
        const result = computeCouponDiscount(coupon, subtotalPaise, new Date());
        if (result.ok) {
          discountPaise = result.discountPaise;
        } else {
          couponError = couponRejectionMessage(result.reason);
        }
      }
    }

    const totals = computeTotalsWithDiscount(subtotalPaise, discountPaise);

    return {
      lines: quoteLines,
      subtotalPaise: totals.subtotalPaise,
      discountPaise: totals.discountPaise,
      taxPaise: totals.taxPaise,
      totalPaise: totals.totalPaise,
      couponCode: code ?? null,
      couponError,
    };
  });
