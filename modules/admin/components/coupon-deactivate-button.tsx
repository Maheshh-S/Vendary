"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import toast from "react-hot-toast";

import { deactivateCoupon } from "@/actions/(admin)/coupons";

export default function CouponDeactivateButton({ couponId }: { couponId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    setBusy(true);
    const result = await deactivateCoupon({ id: couponId });
    setBusy(false);

    if (!result.ok) {
      toast.error(result.message, { id: "admin-deactivate-coupon" });
      return;
    }
    toast.success("Coupon deactivated", { id: "admin-deactivate-coupon" });
    router.refresh();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
    >
      {busy ? "Deactivating…" : "Deactivate"}
    </button>
  );
}
