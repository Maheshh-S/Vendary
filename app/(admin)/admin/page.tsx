
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
import RefundOrderButton from "@/modules/admin/components/refund-order-button";
import AdminSearchControls from "@/modules/admin/components/admin-search-controls";
import PriceEdit from "@/modules/admin/edit/price";
import DescriptionForm from "@/modules/admin/edit/description-form";
import {
  ADMIN_PAGE_SIZE,
  adminHref,
  adminSkip,
  buildAdminOrderWhere,
  buildAdminProductWhere,
  parseAdminSearchQuery,
} from "@/lib/admin/search";
import {
  Pagination,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

function truncateText(text: string | null, maxLength: number = 100) {
  if (!text) return ''
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text
}

const totalPagesFor = (count: number): number =>
  Math.max(1, Math.ceil(count / ADMIN_PAGE_SIZE));

type SearchParams = {
  q?: string | string[];
  page?: string | string[];
};

type Props = {
  searchParams: Promise<SearchParams>;
};

export default async function AdminPage({ searchParams }: Props) {
  const session = await auth();
  if (!session) {
    redirect("/");
  }
  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  const { q, page } = parseAdminSearchQuery(await searchParams);

  // Single-store admin: every ADMIN sees the whole catalog and every order.
  // Product.userId is creator audit only and must never scope visibility or
  // edits (`buildAdminProductWhere` has no userId predicate).
  const productWhere = buildAdminProductWhere(q);
  const orderWhere = buildAdminOrderWhere(q);
  const [productCount, orderCount] = await Promise.all([
    prisma.product.count({ where: productWhere }),
    prisma.order.count({ where: orderWhere }),
  ]);
  const productPages = totalPagesFor(productCount);
  const orderPages = totalPagesFor(orderCount);
  // Both tables share the URL's `page`; clamping keeps a stale page number
  // from rendering an empty table after a search narrows the results.
  const productPage = Math.min(page, productPages);
  const orderPage = Math.min(page, orderPages);

  const [products, orders] = await Promise.all([
    prisma.product.findMany({
      where: productWhere,
      include: {
        category: true,
        images: true,
        videos: true,
        // Creator audit only — visibility is never scoped by it.
        user: { select: { email: true } },
      },
      orderBy: { name: 'asc' },
      take: ADMIN_PAGE_SIZE,
      skip: adminSkip(productPage),
    }),
    prisma.order.findMany({
      where: orderWhere,
      include: {
        user: {
          select: {
            email: true,
          },
        },
        // Snapshots survive product deletion; never join Product for the line name.
        items: true,
        address: true,
      },
      orderBy: { createdAt: 'desc' },
      take: ADMIN_PAGE_SIZE,
      skip: adminSkip(orderPage),
    }),
  ]);
  const serializedProducts = products.map(serializePrismaObject);
  const serializedOrders = orders.map(serializePrismaObject);


  return (
    <div className="px-4 sm:px-6 min-h-screen lg:px-8 my-8">
      <AdminSearchControls q={q} />
      <p className="mt-2 text-sm text-gray-500" data-testid="admin-search-summary">
        {q
          ? `${productCount} product${productCount === 1 ? "" : "s"} and ${orderCount} order${orderCount === 1 ? "" : "s"} matching “${q}”.`
          : `${productCount} product${productCount === 1 ? "" : "s"} · ${orderCount} order${orderCount === 1 ? "" : "s"}.`}
      </p>
      <div className="sm:flex sm:items-center">
        <div className="sm:flex-auto">
          <h1 className="text-xl font-semibold text-gray-900">Products</h1>
          <p className="mt-2 text-sm text-gray-700">
            A list of every product in the store.
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
            <table className="min-w-full" data-testid="admin-products-table">
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
                    Created by
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
                {serializedProducts.length === 0 ? (
                  <tr className="">
                    <td colSpan={9} className="py-4 px-3 text-sm text-center text-gray-500">
                      No products found
                    </td>
                  </tr>
                ) : (
                  serializedProducts.map((product) => (
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
                      <td className="px-3 py-4 text-sm whitespace-nowrap text-gray-500" data-testid="product-creator">
                        {product.user?.email ?? "N/A"}
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
      {productPages > 1 && (
        <Pagination className="mt-4 items-center justify-between">
          <PaginationPrevious href={productPage > 1 ? adminHref(productPage - 1, q) : null} />
          <span className="text-sm text-gray-600">
            Page {productPage} of {productPages} · {productCount} products
          </span>
          <PaginationNext
            href={productPage < productPages ? adminHref(productPage + 1, q) : null}
          />
        </Pagination>
      )}
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
            <table className="min-w-full" data-testid="admin-orders-table">
              <thead>
                <tr>
                  <th className="py-3.5 pr-3 pl-4 text-left text-sm font-semibold text-gray-900 sm:pl-6">
                    Order
                  </th>
                  <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
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
                {serializedOrders.length === 0 ? (
                  <tr className="">
                    <td colSpan={6} className="py-4 px-3 text-sm text-center text-gray-500">
                      No orders yet
                    </td>
                  </tr>
                ) : (
                  serializedOrders.map((order) => (
                    <tr key={order.id}>
                      <td className="py-4 pr-3 pl-4 text-sm font-medium whitespace-nowrap text-gray-900 sm:pl-6">
                        #{String(order.id).slice(0, 8)}
                      </td>
                      <td className="px-3 py-4 text-sm whitespace-nowrap text-gray-500">
                        {order.user?.email ?? "N/A"}
                      </td>
                      <td className="px-3 py-4 text-sm whitespace-nowrap text-gray-500">
                        {order.items.map((item: { productName?: string; quantity: number }, index: number) => (
                          <span key={index}>
                            {index > 0 && ", "}
                            {item.productName || "Unknown product"} x {item.quantity}
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
                          {["confirmed", "shipped", "delivered"].includes(order.status) &&
                            order.paymentId && <RefundOrderButton orderId={order.id} />}
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
      {orderPages > 1 && (
        <Pagination className="mt-4 items-center justify-between">
          <PaginationPrevious href={orderPage > 1 ? adminHref(orderPage - 1, q) : null} />
          <span className="text-sm text-gray-600">
            Page {orderPage} of {orderPages} · {orderCount} orders
          </span>
          <PaginationNext
            href={orderPage < orderPages ? adminHref(orderPage + 1, q) : null}
          />
        </Pagination>
      )}
    </div>
  );
}