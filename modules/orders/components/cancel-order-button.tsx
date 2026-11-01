"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

import { Button } from "@/components/ui/button";
import { cancelOrder } from "@/actions/orders/cancel";

type Props = {
  orderId: string;
  status: string;
};

/**
 * Customer self-serve cancel. Only pending (no capture) and confirmed (full
 * refund) orders are cancellable; the server re-checks ownership and status,
 * so this guard is just presentation.
 */
export default function CancelOrderButton({ orderId, status }: Props) {
  const router = useRouter();

  const { mutate, isPending } = useMutation({
    mutationKey: ["cancel-order", orderId],
    mutationFn: () => cancelOrder(orderId),
    onMutate: () => {
      toast.loading("Cancelling order", { id: `cancel-order-${orderId}` });
    },
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.message, { id: `cancel-order-${orderId}` });
        return;
      }

      if (res.data.status === "cancelled") {
        toast.success("Order cancelled", { id: `cancel-order-${orderId}` });
      } else {
        toast.success(
          "Your refund was issued. The order status could not be updated — support will follow up.",
          { id: `cancel-order-${orderId}` }
        );
      }
      router.refresh();
    },
    onError: () => {
      toast.error("Failed to cancel the order", { id: `cancel-order-${orderId}` });
    },
  });

  if (status !== "pending" && status !== "confirmed") {
    return null;
  }

  const handleClick = () => {
    const message =
      status === "confirmed"
        ? "Cancel this order? The full payment will be refunded to your original payment method and cannot be undone."
        : "Cancel this order? This cannot be undone.";
    if (!window.confirm(message)) {
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
      {isPending ? "Cancelling…" : "Cancel order"}
    </Button>
  );
}
