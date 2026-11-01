import Link from "next/link";
import { redirect } from "next/navigation";

import { listCoupons } from "@/actions/(admin)/coupons";
import { auth } from "@/auth";
import CouponForm from "@/modules/admin/components/coupon-form";
import CouponRow from "@/modules/admin/components/coupon-row";

export const metadata = { title: "Coupons | Vendary" };

export default async function AdminCouponsPage() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    redirect("/");
  }

  const result = await listCoupons();
  const coupons = result.ok ? result.data : [];

  return (
    <div className="mx-auto my-8 min-h-screen max-w-6xl px-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Coupons</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Discounts are applied before GST. Deactivated codes stop validating immediately.
          </p>
        </div>
        <Link
          href="/admin"
          className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
        >
          ← Admin
        </Link>
      </div>

      {!result.ok ? (
        <p className="mt-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {result.message}
        </p>
      ) : null}

      <section className="mt-8 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Create a coupon
        </h2>
        <div className="mt-4">
          <CouponForm />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          All coupons
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full" data-testid="admin-coupons-table">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800">
                <th className="py-3 pr-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Code
                </th>
                <th className="px-3 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Type / value
                </th>
                <th className="px-3 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Window
                </th>
                <th className="px-3 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Min subtotal
                </th>
                <th className="px-3 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Usage
                </th>
                <th className="px-3 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Status
                </th>
                <th className="px-3 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {coupons.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-4 px-3 text-center text-sm text-gray-500">
                    No coupons yet
                  </td>
                </tr>
              ) : (
                coupons.map((coupon) => <CouponRow key={coupon.id} coupon={coupon} />)
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
