"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import toast from "react-hot-toast";

import { deactivateCoupon, updateCoupon, type CouponAdminView } from "@/actions/(admin)/coupons";
import { Input } from "@/components/ui/input";
import { formatINR } from "@/lib/format-inr";

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-IN", {
    dateStyle: "medium",
    timeZone: "Asia/Kolkata",
  });

/** `datetime-local` has no timezone; render it in the admin's local clock. */
const toLocalInput = (iso: string): string => {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
};

const toIsoOrRaw = (value: FormDataEntryValue | null): FormDataEntryValue | null => {
  if (typeof value !== "string" || value === "") return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};

/**
 * Every update sends the full coupon (the schema is a full replacement), so
 * reactivating or editing one field never silently resets another.
 */
const couponUpdateInput = (coupon: CouponAdminView, overrides: Record<string, unknown> = {}) => ({
  id: coupon.id,
  code: coupon.code,
  type: coupon.type,
  value: coupon.value,
  minSubtotal: coupon.minSubtotal,
  maxDiscount: coupon.maxDiscount ?? undefined,
  startsAt: coupon.startsAt,
  endsAt: coupon.endsAt,
  usageLimit: coupon.usageLimit ?? undefined,
  isActive: coupon.isActive,
  ...overrides,
});

type Props = {
  coupon: CouponAdminView;
};

/**
 * One coupon table row plus its inline editor. Reactivate and edit both go
 * through `updateCoupon` — the row carries the current values so toggling
 * `isActive` cannot wipe the window, usage limit, or discount cap.
 */
export default function CouponRow({ coupon }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"deactivate" | "reactivate" | "save" | null>(null);
  const [editing, setEditing] = useState(false);

  const reactivate = async () => {
    setBusy("reactivate");
    const result = await updateCoupon(couponUpdateInput(coupon, { isActive: true }));
    setBusy(null);

    if (!result.ok) {
      toast.error(result.message, { id: `admin-coupon-${coupon.id}` });
      return;
    }
    toast.success(`Coupon ${coupon.code} reactivated`, { id: `admin-coupon-${coupon.id}` });
    router.refresh();
  };

  const deactivate = async () => {
    setBusy("deactivate");
    const result = await deactivateCoupon({ id: coupon.id });
    setBusy(null);

    if (!result.ok) {
      toast.error(result.message, { id: `admin-coupon-${coupon.id}` });
      return;
    }
    toast.success("Coupon deactivated", { id: `admin-coupon-${coupon.id}` });
    router.refresh();
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy("save");

    const result = await updateCoupon(
      couponUpdateInput(coupon, {
        startsAt: toIsoOrRaw(data.get("startsAt")),
        endsAt: toIsoOrRaw(data.get("endsAt")),
        usageLimit: data.get("usageLimit") || undefined,
        maxDiscount: data.get("maxDiscount") || undefined,
      })
    );
    setBusy(null);

    if (!result.ok) {
      toast.error(result.message, { id: `admin-coupon-${coupon.id}` });
      return;
    }
    toast.success(`Coupon ${coupon.code} updated`, { id: `admin-coupon-${coupon.id}` });
    setEditing(false);
    router.refresh();
  };

  return (
    <>
      <tr className="border-b border-gray-100 dark:border-gray-900">
        <td className="py-3 pr-3 text-sm font-medium text-gray-900 dark:text-gray-100">
          {coupon.code}
        </td>
        <td className="px-3 py-3 text-sm text-gray-700 dark:text-gray-300">
          {coupon.type === "PERCENT" ? `${coupon.value}%` : formatINR(coupon.value)}
          {coupon.maxDiscount !== null ? ` · max ${formatINR(coupon.maxDiscount)}` : ""}
        </td>
        <td className="px-3 py-3 text-sm text-gray-700 dark:text-gray-300">
          {formatDate(coupon.startsAt)} → {formatDate(coupon.endsAt)}
        </td>
        <td className="px-3 py-3 text-sm text-gray-700 dark:text-gray-300">
          {formatINR(coupon.minSubtotal)}
        </td>
        <td className="px-3 py-3 text-sm text-gray-700 dark:text-gray-300">
          {coupon.usedCount} / {coupon.usageLimit ?? "∞"}
        </td>
        <td className="px-3 py-3 text-sm">
          <span
            className={
              coupon.isActive
                ? "rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/50 dark:text-green-200"
                : "rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300"
            }
          >
            {coupon.isActive ? "Active" : "Inactive"}
          </span>
        </td>
        <td className="px-3 py-3 text-right text-sm">
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing((open) => !open)}
              aria-expanded={editing}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
            >
              {editing ? "Close" : "Edit"}
            </button>
            {coupon.isActive ? (
              <button
                type="button"
                onClick={deactivate}
                disabled={busy !== null}
                className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
              >
                {busy === "deactivate" ? "Deactivating…" : "Deactivate"}
              </button>
            ) : (
              <button
                type="button"
                onClick={reactivate}
                disabled={busy !== null}
                className="rounded-md border border-green-300 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-green-800 dark:text-green-300 dark:hover:bg-green-950/40"
              >
                {busy === "reactivate" ? "Reactivating…" : "Reactivate"}
              </button>
            )}
          </div>
        </td>
      </tr>
      {editing ? (
        <tr className="border-b border-gray-100 dark:border-gray-900">
          <td colSpan={7} className="bg-gray-50 px-3 py-3 dark:bg-gray-950/40">
            <form onSubmit={save} data-testid="coupon-edit-form" className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="text-sm">
                  <span className="font-medium text-gray-700 dark:text-gray-300">Starts at</span>
                  <Input
                    name="startsAt"
                    type="datetime-local"
                    required
                    defaultValue={toLocalInput(coupon.startsAt)}
                    className="mt-1"
                  />
                </label>
                <label className="text-sm">
                  <span className="font-medium text-gray-700 dark:text-gray-300">Ends at</span>
                  <Input
                    name="endsAt"
                    type="datetime-local"
                    required
                    defaultValue={toLocalInput(coupon.endsAt)}
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
                    defaultValue={coupon.usageLimit ?? ""}
                    className="mt-1"
                  />
                </label>
                <label className="text-sm">
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    Max discount (₹)
                  </span>
                  <Input
                    name="maxDiscount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    placeholder="None"
                    defaultValue={coupon.maxDiscount ?? ""}
                    className="mt-1"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={busy !== null}
                className="rounded-md bg-slate-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy === "save" ? "Saving…" : "Save changes"}
              </button>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}
