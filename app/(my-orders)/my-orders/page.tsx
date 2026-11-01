import { auth } from "@/auth";
import { prisma } from "@/lib/db/prisma";
import { serializePrismaObject } from "@/lib/db/serializer";
import { formatINR } from "@/lib/format-inr";
import Link from "next/link";
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
        // Item snapshots are the source of truth: the product row may be gone.
        items: true,
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
            <li key={order.id}>
              <Link
                href={`/my-orders/${order.id}`}
                className="block rounded-lg border border-gray-200 p-4 shadow-xs transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-gray-800 dark:hover:border-gray-700 dark:hover:bg-gray-900"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    Order #{String(order.id).slice(0, 8)}
                  </p>
                  <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium capitalize text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                    {order.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {new Date(order.createdAt).toLocaleDateString("en-IN")}
                </p>

                <ul className="mt-3 space-y-1">
                  {order.items.map(
                    (item: { id: string; productName: string; quantity: number }) => (
                      <li key={item.id} className="text-sm text-gray-700 dark:text-gray-300">
                        {item.productName} × {item.quantity}
                      </li>
                    )
                  )}
                </ul>

                <div className="mt-3 flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">
                    Total: {formatINR(Number(order.total))}
                  </p>
                  <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
                    View details →
                  </span>
                </div>

                {order.address && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {order.address.firstName} {order.address.lastName}, {order.address.address},{" "}
                    {order.address.area}, {order.address.postalCode}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
