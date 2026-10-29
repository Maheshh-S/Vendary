
import { auth } from "@/auth";
import {prisma} from "@/lib/db/prisma";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cn } from "@/lib/utils";
import TakeOfflineSwitch from "@/modules/admin/components/take-offline-switch";
import AddImages from "@/modules/admin/components/add-image";
import { serializePrismaObject } from "@/lib/db/serializer";
import { formatINR } from "@/lib/format-inr";
import DeleteProductButton from "@/modules/admin/components/delete-product-button";
import OrderStatusSelect from "@/modules/admin/components/order-status-select";
import PriceEdit from "@/modules/admin/edit/price";
import DescriptionForm from "@/modules/admin/edit/description-form";

function truncateText(text: string | null, maxLength: number = 100) {
  if (!text) return ''
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text
}

export default async function AdminPage() {
  const session = await auth();
  if (!session) {
    redirect("/");
  }
  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  // Fetch all products without pagination or search filters
 const products = (await prisma.product.findMany({
  include: {
    category: true,
    images: true,
    videos: true,
  },
  where: {
    userId: session.user.id,
  },
   orderBy: { name: 'asc' },
 })).map(serializePrismaObject);

 const orders = (await prisma.order.findMany({
  include: {
    user: {
      select: {
        email: true,
      },
    },
    items: {
      include: {
        product: {
          select: {
            name: true,
          },
        },
      },
    },
    address: true,
  },
  orderBy: { createdAt: 'desc' },
 })).map(serializePrismaObject);


  return (
    <div className="px-4 sm:px-6 min-h-screen lg:px-8 my-8">
      <div className="sm:flex sm:items-center">
        <div className="sm:flex-auto">
          <h1 className="text-xl font-semibold text-gray-900">Products</h1>
          <p className="mt-2 text-sm text-gray-700">
            A list of all products in your account.
          </p>
        </div>
        <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
          <Link
            href={"/admin/create-product"}
            type="button"
            className="block rounded-md bg-slate-600 px-3 py-2 text-center text-sm font-semibold text-white shadow-xs hover:bg-slate-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600"
          >
            Add Product
          </Link>
        </div>
      </div>
      <div className="mt-8 flow-root overflow-x-auto">
        <div className="inline-block min-w-full py-2 align-middle">
          <div className="overflow-hidden ring-1 shadow-sm ring-black/5 sm:rounded-lg">
            <table className="min-w-full">
              <thead>
                <tr>
                  <th className="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-gray-900 sm:pl-6">
                    Name
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Price
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Shipping Time
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Category
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Images
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Description
                  </th>
                  <th className="px-3 py-3.5 text-right text-sm font-semibold text-gray-900">
                    Product Online
                  </th>
                  <th className="px-3 py-3.5 text-right text-sm font-semibold text-gray-900">
                    Delete
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.length === 0 ? (
                  <tr className="">
                    <td colSpan={8} className="py-4 px-3 text-sm text-center text-gray-500">
                      No products found
                    </td>
                  </tr>
                ) : (
                  products.map((product) => (
                    <tr key={product.id} className={cn(product.images.length === 0 && "bg-red-100")}>
                      <td className="py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-gray-900 sm:pl-6">
                        <Link href={`/products/${product.id}`} className="text-blue-700 hover:text-blue-900 hover:underline">{truncateText(product.name, 30)}</Link>
                      </td>
                      <td className="py-4 text-sm whitespace-nowrap flex items-center justify-center space-x-2 text-gray-500">
                        ₹ <PriceEdit productId={product.id} price={Number(product.price)} />
                      </td>
                      <td className="px-3 py-4 text-sm whitespace-nowrap text-gray-500">
                        {product.shippingTime}
                      </td>
                      <td className="px-3 py-4 text-sm whitespace-nowrap text-gray-500">
                        {product.category?.name || "N/A"}
                      </td>
                      <td className="px-3 py-4 text-sm whitespace-nowrap text-gray-500">
                        {product.images.length === 0 ? <AddImages product={product} /> : product.images.length}
                      </td>
                      <td className="px-3 py-4 text-sm whitespace-nowrap text-gray-500">
                        <DescriptionForm productId={product.id} description={product.description} shortDescription={product.shortDescription} />
                      </td>
                      <td className="px-3 py-4 text-sm text-right whitespace-nowrap">
                        <TakeOfflineSwitch product={product} />
                      </td>
                      <td className="px-3 py-4 text-sm text-right whitespace-nowrap">
                        <DeleteProductButton productId={product.id} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="mt-12 sm:flex sm:items-center">
        <div className="sm:flex-auto">
          <h1 className="text-xl font-semibold text-gray-900">Orders</h1>
          <p className="mt-2 text-sm text-gray-700">
            A list of all orders placed by customers.
          </p>
        </div>
      </div>
      <div className="mt-8 flow-root overflow-x-auto">
        <div className="inline-block min-w-full py-2 align-middle">
          <div className="overflow-hidden ring-1 shadow-sm ring-black/5 sm:rounded-lg">
            <table className="min-w-full">
              <thead>
                <tr>
                  <th className="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-gray-900 sm:pl-6">
                    Customer
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Items
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Total
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Payment ID
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 ? (
                  <tr className="">
                    <td colSpan={5} className="py-4 px-3 text-sm text-center text-gray-500">
                      No orders yet
                    </td>
                  </tr>
                ) : (
                  orders.map((order) => (
                    <tr key={order.id}>
                      <td className="py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-gray-900 sm:pl-6">
                        {order.user?.email ?? "N/A"}
                      </td>
                      <td className="px-3 py-4 text-sm whitespace-nowrap text-gray-500">
                        {order.items.map((item: { product?: { name?: string } | null; quantity: number }, index: number) => (
                          <span key={index}>
                            {index > 0 && ", "}
                            {item.product?.name ?? "Unknown product"} x {item.quantity}
                          </span>
                        ))}
                      </td>
                      <td className="px-3 py-4 text-sm whitespace-nowrap text-gray-500">
                        {formatINR(Number(order.total))}
                      </td>
                      <td className="px-3 py-4 text-sm whitespace-nowrap text-gray-500">
                        {order.paymentId || "N/A"}
                      </td>
                      <td className="px-3 py-4 text-sm whitespace-nowrap text-gray-500">
                        <div className="flex items-center gap-2">
                          <span>{order.status}</span>
                          <OrderStatusSelect orderId={order.id} status={order.status} />
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}