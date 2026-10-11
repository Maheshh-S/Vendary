"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/db/prisma";
import { serializePrismaObject } from "@/lib/db/serializer";
import { formatINR } from "@/lib/format-inr";
import { redirect } from "next/navigation";

export default async function MyOrdersPage() {
  const session = await auth();
  if (!session) {
    redirect("/");
  }

  const orders = (
    await prisma.order.findMany({
      where: { userId: session.user.id },
      include: {
        items: { include: { product: true } },
        address: true,
      },
      orderBy: { createdAt: "desc" },
    })
  ).map(serializePrismaObject);

  return (
    <div className="px-4 sm:px-6 min-h-screen lg:px-8 my-8">
      <h1 className="text-xl font-semibold text-gray-900">My Orders</h1>

      {orders.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">No orders yet</p>
      ) : (
        <ul className="mt-6 space-y-6">
          {orders.map((order) => (
            <li
              key={order.id}
              className="rounded-lg border border-gray-200 p-4 shadow-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-900">
                  Order #{String(order.id).slice(0, 8)}
                </p>
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800">
                  {order.status}
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {new Date(order.createdAt).toLocaleDateString("en-IN")}
              </p>

              <ul className="mt-3 space-y-1">
                {order.items.map((item: { id: string; quantity: number; product?: { name?: string } | null }) => (
                  <li key={item.id} className="text-sm text-gray-700">
                    {item.product?.name ?? "Product"} × {item.quantity}
                  </li>
                ))}
              </ul>

              <p className="mt-3 text-sm font-semibold text-gray-900">
                Total: {formatINR(Number(order.total))}
              </p>

              {order.address && (
                <p className="mt-1 text-xs text-gray-500">
                  {order.address.firstName} {order.address.lastName},{" "}
                  {order.address.address}, {order.address.area},{" "}
                  {order.address.postalCode}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
