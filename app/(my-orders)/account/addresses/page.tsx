import Link from "next/link"
import { redirect } from "next/navigation"

import { auth } from "@/auth"
import { prisma } from "@/lib/db/prisma"
import {
  AddressCard,
  AddressForm,
} from "@/modules/account/components/address-form"
import { toSavedAddressView } from "@/modules/account/types"
import { MAX_SAVED_ADDRESSES } from "@/schemas/account/address-schema"

export const metadata = { title: "Saved addresses | Vendary" }

export default async function AddressBookPage() {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/")
  }

  const rows = await prisma.savedAddress.findMany({
    where: { userId: session.user.id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  })
  const addresses = rows.map(toSavedAddressView)

  return (
    <main className="mx-auto my-8 max-w-3xl px-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
            Saved addresses
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {addresses.length} of {MAX_SAVED_ADDRESSES} saved. Your default address
            pre-fills checkout.
          </p>
        </div>
        <Link
          href="/account"
          className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
        >
          ← Account settings
        </Link>
      </div>

      <section className="mt-8 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Add an address
        </h2>
        <div className="mt-4">
          <AddressForm />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Your addresses
        </h2>
        {addresses.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            No saved addresses yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-4">
            {addresses.map((address) => (
              <AddressCard key={address.id} address={address} />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
