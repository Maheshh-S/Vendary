"use client";

import USDToINRConverter from "@/components/global/currency-converter";
import { Divider } from "@/components/ui/divider";
import { formatPrice } from "@/lib/locales";
import { useLocale } from "@/providers/locale-provider";
import { computeOrderTotals, GST_RATE } from "@/lib/money";
import { CheckoutSession } from "@/modules/products/types/checkout";
import { quoteLineIssueLabel } from "@/schemas/cart/quote-schema";
import type { CartQuote, CartQuoteIssue } from "@/schemas/cart/quote-schema";
import React from "react";
import CouponForm from "./_coupon-form";

export type CouponFormState = {
  value: string;
  appliedCode: string | null;
  isValidating: boolean;
  onChange: (value: string) => void;
  onApply: () => void;
  onRemove: () => void;
};

type Props = {
  checkoutSession?: CheckoutSession;
  /** Authoritative server quote; falls back to the stored session snapshot. */
  quote?: CartQuote | null;
  /** Present on checkout; the cart summary renders without coupon controls. */
  coupon?: CouponFormState;
};

type SummaryLine = {
  productId: string;
  name: string;
  image: string | null;
  unitPaise: number;
  quantity: number;
  stockQty: number | null;
  issue: CartQuoteIssue;
};

const issueLabel = (line: SummaryLine): string | null =>
  quoteLineIssueLabel({ issue: line.issue, stockQty: line.stockQty ?? 0 });

const ItemsSummary = ({ checkoutSession, quote, coupon }: Props) => {
  const { locale } = useLocale();
  // Default to empty array if line_items is undefined
  const lineItems = checkoutSession?.line_items || [];

  function truncateText(text: string | null, maxLength: number = 100) {
    if (!text) return "";
    return text.length > maxLength ? text.substring(0, maxLength) + "..." : text;
  }

  // The quote re-prices from the database (same math the server charges with);
  // the stored session snapshot is only the pre-quote fallback.
  const lines: SummaryLine[] = quote
    ? quote.lines.map((line) => ({
        productId: line.productId,
        name: line.name,
        image: line.image,
        unitPaise: line.unitPaise,
        quantity: line.quantity,
        stockQty: line.stockQty,
        issue: line.issue,
      }))
    : lineItems.map((item) => ({
        productId: item.productId,
        name: item.price_data.product_data.name,
        image: item.price_data.product_data.images?.[0] ?? null,
        unitPaise: Math.round(item.price_data.unit_amount),
        quantity: item.quantity,
        stockQty: null,
        issue: null,
      }));

  // Authoritative quote first; the localStorage snapshot is only a fallback
  // while the quote is in flight.
  const fallbackTotals = computeOrderTotals(
    lines.map((line) => ({
      unitPaise: line.unitPaise,
      quantity: line.quantity,
    }))
  );
  const subtotalPaise = quote?.subtotalPaise ?? fallbackTotals.subtotalPaise;
  const discountPaise = quote?.discountPaise ?? 0;
  const taxPaise = quote?.taxPaise ?? fallbackTotals.taxPaise;
  const totalPaise = quote?.totalPaise ?? fallbackTotals.totalPaise;

  // unit_amount values are paise; convert to rupees before formatting.
  const formatCurrency = (amount: number) => {
    return formatPrice(amount / 100, locale);
  };

  // Show loading or empty state if no checkout session is available
  if (!checkoutSession) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-medium mb-6">Order Summary</h1>
        <div className="py-12 text-center">
          <p className="text-gray-500">Loading checkout information...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="py-6">
      <h1 className="text-2xl font-medium mb-6">Order Summary</h1>

      {lines.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-gray-500">No items in your cart</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Product list */}
          <div className="space-y-4">
            {lines.map((line, index) => {
              const issue = issueLabel(line);
              return (
                <div
                  key={`${line.productId}-${index}`}
                  className="flex items-center justify-between py-3"
                >
                  <div className="flex items-center space-x-3">
                    {line.image && (
                      <div className="flex-shrink-0">
                        <img
                          src={line.image}
                          alt={line.name}
                          className="w-16 h-16 object-cover rounded-md"
                        />
                      </div>
                    )}
                    <div>
                      <p className="font-medium">
                        {truncateText(line.name || "Unavailable item", 30)}
                      </p>
                      <div className="flex items-center mt-1 text-sm text-gray-600">
                        <span>{formatCurrency(line.unitPaise)}</span>
                        <span className="mx-2">×</span>
                        <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full text-xs">
                          {line.quantity}
                        </span>
                      </div>
                      {issue && <p className="mt-1 text-xs font-medium text-red-600">{issue}</p>}
                    </div>
                  </div>
                  <div className="font-medium">
                    {formatCurrency(line.unitPaise * line.quantity)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Divider */}
          <div className="h-px bg-gray-100 my-4"></div>

          {/* Order totals */}
          <div className="space-y-3">
            {coupon ? (
              <CouponForm
                value={coupon.value}
                appliedCode={coupon.appliedCode}
                error={quote?.couponCode ? quote.couponError : null}
                isValidating={coupon.isValidating}
                discountPaise={discountPaise}
                onChange={coupon.onChange}
                onApply={coupon.onApply}
                onRemove={coupon.onRemove}
              />
            ) : null}
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span data-testid="summary-subtotal">{formatCurrency(subtotalPaise)}</span>
            </div>
            {discountPaise > 0 ? (
              <div className="flex justify-between text-green-700 dark:text-green-400">
                <span>Discount{quote?.couponCode ? ` (${quote.couponCode})` : ""}</span>
                <span data-testid="summary-discount">−{formatCurrency(discountPaise)}</span>
              </div>
            ) : null}
            <div className="flex justify-between">
              <span>Tax ({(GST_RATE * 100).toFixed(0)}% GST)</span>
              <span data-testid="summary-tax">{formatCurrency(taxPaise)}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Total</span>
              <span data-testid="summary-total">{formatCurrency(totalPaise)}</span>
            </div>
            <Divider />

            <USDToINRConverter />
          </div>
        </div>
      )}
    </div>
  );
};

export default ItemsSummary;
