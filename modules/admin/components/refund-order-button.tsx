"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

import { Button } from "@/components/ui/button";
import { refundOrder } from "@/actions/(admin)/orders/refund";

type Props = {
  orderId: string;
};

/**
 * Admin full-refund control for a paid order. The order status select remains
 * a record-only override; this button is the money-moving path.
 */
export default function RefundOrderButton({ orderId }: Props) {
  const router = useRouter();

  const { mutate, isPending } = useMutation({
    mutationKey: ["refund-order", orderId],
    mutationFn: () => refundOrder(orderId),
    onMutate: () => {
      toast.loading("Issuing refund", { id: `refund-order-${orderId}` });
    },
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.message, { id: `refund-order-${orderId}` });
        return;
      }

      toast.success(
        res.data.status === "refunded"
          ? "Refund issued and order marked refunded"
          : "Refund issued. The order status needs reconciliation.",
        { id: `refund-order-${orderId}` }
      );
      router.refresh();
    },
    onError: () => {
      toast.error("Failed to issue the refund", { id: `refund-order-${orderId}` });
    },
  });

  const handleClick = () => {
    if (
      !window.confirm(
        "Issue a full Razorpay refund for this order? Stock is restored for confirmed orders and the action cannot be undone."
      )
    ) {
      return;
    }
    mutate();
  };

  return (
    <Button
      type="button"
      color="red"
      onClick={handleClick}
      disabled={isPending}
      className="text-sm"
    >
      {isPending ? "Refunding…" : "Refund"}
    </Button>
  );
}
