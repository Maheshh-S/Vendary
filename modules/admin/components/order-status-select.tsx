"use client";
import { useEffect, useState, type ChangeEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import toast from "react-hot-toast";
import type { OrderStatus } from "@prisma/client";
import { Select } from "@/components/ui/select";
import { updateOrderStatus } from "@/actions/orders";
import { ADMIN_TRANSITIONS } from "@/lib/orders/status";

const isOrderStatus = (value: string): value is OrderStatus =>
  Object.prototype.hasOwnProperty.call(ADMIN_TRANSITIONS, value);

type Props = {
  orderId: string;
  status: string;
};

const OrderStatusSelect = ({ orderId, status }: Props) => {
  const [value, setValue] = useState(status);

  // Keep the control in sync when the server renders a newer status (e.g. the
  // webhook or a concurrent admin changed it).
  useEffect(() => {
    setValue(status);
  }, [status]);

  const { mutate, isPending } = useMutation({
    mutationKey: ["update-order-status", orderId],
    mutationFn: (nextStatus: string) => updateOrderStatus(orderId, nextStatus),
    onMutate: () => {
      toast.loading("Updating order status", { id: `order-status-${orderId}` });
    },
    onSuccess: (res) => {
      if (!res.ok) {
        // The controlled value was never advanced, so the select snaps back to
        // the order's actual status while the reason is shown.
        toast.error(res.message, { id: `order-status-${orderId}` });
        return;
      }

      setValue(res.data.to);
      toast.success("Order status updated", { id: `order-status-${orderId}` });
    },
    onError: () => {
      toast.error("Failed to update order status", { id: `order-status-${orderId}` });
    },
  });

  const current: OrderStatus = isOrderStatus(value) ? value : "pending";
  // Admin-only edges: `confirmed` is intentionally absent for pending orders,
  // because only the payment-verified `confirmOrder` path may confirm, and
  // pending orders have no cancel option until the Phase 1 refund flow.
  const nextStates = ADMIN_TRANSITIONS[current];
  const options: OrderStatus[] = [current, ...nextStates];

  // Cancelling or refunding here is a record-only override: no money moves.
  // Make the admin acknowledge that before the mutation runs.
  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    if (
      (next === "cancelled" || next === "refunded") &&
      !window.confirm(
        "This changes the order status only and does NOT issue a Razorpay refund. Continue?"
      )
    ) {
      // Keep the current selection. A controlled select normally snaps back on
      // re-render, but no state changed here, so reset the DOM value directly.
      e.target.value = current;
      return;
    }
    mutate(next);
  };

  return (
    <Select
      value={current}
      disabled={isPending || nextStates.length === 0}
      aria-label="Order status"
      title="Phase 0: status changes are record-only; no Razorpay refund is issued."
      onChange={handleChange}
    >
      {options.map((s) => (
        <option key={s} value={s} className="capitalize">
          {s}
        </option>
      ))}
    </Select>
  );
};

export default OrderStatusSelect;
