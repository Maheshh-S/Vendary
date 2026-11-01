"use client";

import Link from "next/link";

import { formatINR } from "@/lib/format-inr";
import { computeInvoiceTotals, invoiceNumber, invoiceYear } from "@/lib/orders/invoice";
import { PROJECT_NAME } from "@/metadata";

export type InvoiceOrderView = {
  id: string;
  createdAt: string;
  status: string;
  paymentMethod: string;
  total: number;
  taxAmount: number;
  discountAmount: number;
  couponCode: string | null;
  items: {
    id: string;
    productName: string;
    quantity: number;
    price: number;
  }[];
  address: {
    firstName: string;
    lastName: string;
    phone: string;
    address: string;
    area: string;
    landmark: string;
    postalCode: string;
    state: string;
    country: string;
  } | null;
};

const formatRupees = (paise: number): string => formatINR(paise / 100);

const formatDate = (value: string): string =>
  new Date(value).toLocaleDateString("en-IN", {
    dateStyle: "long",
    timeZone: "Asia/Kolkata",
  });

/**
 * Printable GST invoice. Amounts are derived from the immutable order/item
 * snapshots (never current product prices), and the seller GSTIN row is
 * omitted entirely when `SELLER_GSTIN` is unset.
 */
export default function Invoice({
  order,
  gstin,
}: {
  order: InvoiceOrderView;
  gstin: string | null;
}) {
  const amounts = computeInvoiceTotals(order);
  const number = invoiceNumber(order.id, invoiceYear(order.createdAt));

  return (
    <div className="invoice mx-auto my-8 max-w-3xl px-4 sm:px-6">
      <div className="invoice-actions mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href={`/my-orders/${order.id}`}
          className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
        >
          ← Back to order
        </Link>
        <button
          type="button"
          data-testid="print-invoice"
          onClick={() => window.print()}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Print / Save as PDF
        </button>
      </div>

      <article className="rounded-lg border border-gray-300 bg-white p-8 text-gray-900 shadow-sm print:border-0 print:p-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-300 pb-4">
          <div>
            <h1 className="text-xl font-bold">{PROJECT_NAME}</h1>
            <p className="text-sm text-gray-600">Tax Invoice</p>
            {gstin ? (
              <p data-testid="seller-gstin" className="mt-1 text-sm text-gray-700">
                GSTIN: {gstin}
              </p>
            ) : null}
          </div>
          <div className="text-right text-sm">
            <p data-testid="invoice-number" className="font-semibold">
              {number}
            </p>
            <p className="text-gray-600">Date: {formatDate(order.createdAt)}</p>
            <p className="text-gray-600">Order: #{order.id.slice(0, 8)}</p>
            <p className="text-gray-600 capitalize">Status: {order.status}</p>
          </div>
        </header>

        <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Billed to
            </h2>
            {order.address ? (
              <address className="mt-2 text-sm not-italic leading-6 text-gray-800">
                {order.address.firstName} {order.address.lastName}
                <br />
                {order.address.address}
                <br />
                {order.address.area}
                {order.address.landmark ? `, ${order.address.landmark}` : ""}
                <br />
                {order.address.state} {order.address.postalCode}
                <br />
                {order.address.country}
                <br />
                {order.address.phone}
              </address>
            ) : (
              <p className="mt-2 text-sm text-gray-600">No address on file.</p>
            )}
          </div>
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Payment</h2>
            <p className="mt-2 text-sm text-gray-800">{order.paymentMethod}</p>
            <p className="text-sm text-gray-600">Paid in INR</p>
          </div>
        </section>

        <table className="mt-8 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              <th className="py-2 pr-2 font-semibold">Item</th>
              <th className="py-2 pr-2 text-right font-semibold">Qty</th>
              <th className="py-2 pr-2 text-right font-semibold">Unit price</th>
              <th className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => {
              const unitPaise = Math.round(Number(item.price) * 100);
              return (
                <tr key={item.id} className="border-b border-gray-200">
                  <td className="py-2 pr-2">{item.productName}</td>
                  <td className="py-2 pr-2 text-right">{item.quantity}</td>
                  <td className="py-2 pr-2 text-right">{formatRupees(unitPaise)}</td>
                  <td className="py-2 text-right">{formatRupees(unitPaise * item.quantity)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <dl className="mt-6 ml-auto w-full max-w-xs space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-600">Subtotal</dt>
            <dd data-testid="invoice-subtotal">{formatRupees(amounts.subtotalPaise)}</dd>
          </div>
          {amounts.discountPaise > 0 ? (
            <div className="flex justify-between">
              <dt className="text-gray-600">
                Discount{order.couponCode ? ` (${order.couponCode})` : ""}
              </dt>
              <dd data-testid="invoice-discount">−{formatRupees(amounts.discountPaise)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between">
            <dt className="text-gray-600">GST</dt>
            <dd data-testid="invoice-tax">{formatRupees(amounts.taxPaise)}</dd>
          </div>
          <div className="flex justify-between border-t border-gray-300 pt-2 text-base font-semibold">
            <dt>Total</dt>
            <dd data-testid="invoice-total">{formatRupees(amounts.totalPaise)}</dd>
          </div>
        </dl>

        <footer className="mt-8 border-t border-gray-200 pt-4 text-xs text-gray-500">
          This is a computer-generated invoice. Amounts reflect the order at the time it was placed.
        </footer>
      </article>
    </div>
  );
}
