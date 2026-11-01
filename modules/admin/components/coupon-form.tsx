"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import toast from "react-hot-toast";

import { createCoupon } from "@/actions/(admin)/coupons";
import { Input } from "@/components/ui/input";

const toLocalInput = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
};

const fieldErrorsText = (fieldErrors?: Record<string, string[]>): string | null => {
  if (!fieldErrors) return null;
  const messages = Object.values(fieldErrors).flat();
  return messages.length > 0 ? messages.join(" ") : null;
};

/**
 * `datetime-local` has no timezone; convert it in the browser so the coupon
 * window reflects the admin's clock instead of the server process timezone.
 */
const toIsoOrRaw = (value: FormDataEntryValue | null): FormDataEntryValue | null => {
  if (typeof value !== "string" || value === "") return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};

/** Minimal coupon creator. Server validation is the contract; this only collects input. */
export default function CouponForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = new Date();
  const inThirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);

    const result = await createCoupon({
      code: data.get("code"),
      type: data.get("type"),
      value: data.get("value"),
      minSubtotal: data.get("minSubtotal") || undefined,
      maxDiscount: data.get("maxDiscount") || undefined,
      startsAt: toIsoOrRaw(data.get("startsAt")),
      endsAt: toIsoOrRaw(data.get("endsAt")),
      usageLimit: data.get("usageLimit") || undefined,
      isActive: data.get("isActive") === "on",
    });

    setBusy(false);
    if (!result.ok) {
      const detail = fieldErrorsText(result.fieldErrors);
      setError(detail ? `${result.message} ${detail}` : result.message);
      toast.error(result.message, { id: "admin-create-coupon" });
      return;
    }

    form.reset();
    toast.success(`Coupon ${result.data.code} created`, { id: "admin-create-coupon" });
    router.refresh();
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" data-testid="coupon-create-form">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">Code</span>
          <Input name="code" required placeholder="SAVE10" className="mt-1 uppercase" />
        </label>
        <label className="text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">Type</span>
          <select
            name="type"
            defaultValue="PERCENT"
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            <option value="PERCENT">Percent</option>
            <option value="FIXED">Fixed (₹)</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">Value</span>
          <Input
            name="value"
            type="number"
            step="0.01"
            min="0.01"
            required
            placeholder="10"
            className="mt-1"
          />
        </label>
        <label className="text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">Min subtotal (₹)</span>
          <Input
            name="minSubtotal"
            type="number"
            step="0.01"
            min="0"
            placeholder="0"
            className="mt-1"
          />
        </label>
        <label className="text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">Max discount (₹)</span>
          <Input
            name="maxDiscount"
            type="number"
            step="0.01"
            min="0.01"
            placeholder="Optional"
            className="mt-1"
          />
        </label>
        <label className="text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">Starts at</span>
          <Input
            name="startsAt"
            type="datetime-local"
            required
            defaultValue={toLocalInput(now)}
            className="mt-1"
          />
        </label>
        <label className="text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">Ends at</span>
          <Input
            name="endsAt"
            type="datetime-local"
            required
            defaultValue={toLocalInput(inThirtyDays)}
            className="mt-1"
          />
        </label>
        <label className="text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">Usage limit</span>
          <Input
            name="usageLimit"
            type="number"
            min="1"
            step="1"
            placeholder="Unlimited"
            className="mt-1"
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" name="isActive" defaultChecked className="size-4" />
        Active immediately
      </label>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-slate-600 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Creating…" : "Create coupon"}
      </button>
    </form>
  );
}
