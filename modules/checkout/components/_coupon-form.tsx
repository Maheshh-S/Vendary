"use client";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = {
  value: string;
  appliedCode: string | null;
  error: string | null;
  isValidating: boolean;
  discountPaise: number;
  onChange: (value: string) => void;
  onApply: () => void;
  onRemove: () => void;
};

const formatRupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

/**
 * Coupon entry for checkout. The applied code is owned by the checkout page
 * (it is part of the quote key), so this component only renders state and
 * forwards intents. A rejected code keeps the input editable: the shopper can
 * correct it or remove it, and payment stays disabled until one of those.
 */
export default function CouponForm({
  value,
  appliedCode,
  error,
  isValidating,
  discountPaise,
  onChange,
  onApply,
  onRemove,
}: Props) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
      <label
        htmlFor="coupon-code"
        className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
      >
        Coupon code
      </label>
      <div className="mt-2 flex items-center gap-2">
        <Input
          id="coupon-code"
          name="coupon-code"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="SAVE10"
          autoComplete="off"
          disabled={isValidating}
          className="uppercase"
        />
        {appliedCode === null || error ? (
          <button
            type="button"
            onClick={onApply}
            disabled={isValidating || value.trim() === ""}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Apply
          </button>
        ) : null}
        {appliedCode !== null ? (
          <button
            type="button"
            onClick={onRemove}
            disabled={isValidating}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Remove
          </button>
        ) : null}
      </div>

      {isValidating ? (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Checking coupon…</p>
      ) : error ? (
        <p role="alert" className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : appliedCode ? (
        <p
          className={cn(
            "mt-2 text-xs font-medium",
            discountPaise > 0
              ? "text-green-700 dark:text-green-400"
              : "text-amber-700 dark:text-amber-400"
          )}
        >
          {discountPaise > 0
            ? `${appliedCode} applied — you save ${formatRupees(discountPaise)}.`
            : `${appliedCode} applied — no discount on this cart.`}
        </p>
      ) : (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Have a code? Enter it before paying.
        </p>
      )}
    </div>
  );
}
