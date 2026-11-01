"use client";

import { useQuery } from "@tanstack/react-query";

import { getCartQuote } from "@/actions/cart/quote";
import type { CartQuote } from "@/schemas/cart/quote-schema";

export type CartQuoteLineInput = {
  productId: string;
  quantity: number;
};

/**
 * Fetches the authoritative cart quote for the current local cart. The query
 * key is a stable serialization of the lines, so quantity changes and
 * additions refetch while untouched carts stay cached.
 */
export function useCartQuote(lineItems: readonly CartQuoteLineInput[]) {
  const queryKey = lineItems.map((line) => `${line.productId}:${line.quantity}`).join("|");

  const query = useQuery({
    queryKey: ["cart-quote", queryKey],
    queryFn: () => getCartQuote(lineItems),
    enabled: lineItems.length > 0,
    // Short-lived: stock can change while a shopper is on the page.
    staleTime: 15_000,
  });

  const result = query.data;
  const quote: CartQuote | null = result?.ok ? result.data : null;
  const errorMessage =
    result && !result.ok
      ? result.message
      : query.error instanceof Error
        ? query.error.message
        : null;

  return {
    quote,
    errorMessage,
    isLoading: lineItems.length > 0 && query.isPending,
    refetch: query.refetch,
  };
}
