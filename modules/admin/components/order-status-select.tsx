"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Select } from "@/components/ui/select";
import { updateOrderStatus } from "@/actions/orders";

const STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"];

type Props = {
  orderId: string;
  status: string;
};

const OrderStatusSelect = ({ orderId, status }: Props) => {
  const [value, setValue] = useState(status);

  const { mutate, isPending } = useMutation({
    mutationKey: ["update-order-status", orderId],
    mutationFn: ({ orderId, status }: { orderId: string; status: string }) =>
      updateOrderStatus(orderId, status),
    onMutate: () => {
      toast.loading("Updating order status", { id: `order-status-${orderId}` });
    },
    onSuccess: (updated) => {
      setValue(updated.status);
      toast.success("Order status updated", { id: `order-status-${orderId}` });
    },
    onError: () => {
      toast.error("Failed to update order status", { id: `order-status-${orderId}` });
    },
  });

  return (
    <Select
      value={value}
      disabled={isPending}
      aria-label="Order status"
      onChange={(e) => mutate({ orderId, status: e.target.value })}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </Select>
  );
};

export default OrderStatusSelect;
