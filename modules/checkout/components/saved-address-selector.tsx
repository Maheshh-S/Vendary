"use client"

import { useEffect, useRef, useState } from "react"

import { listAddresses } from "@/actions/account/addresses"
import { toSavedAddressView, type SavedAddressView } from "@/modules/account/types"

/**
 * Loads the signed-in user's address book and offers it above the checkout
 * fields. Selecting an address only fills the form: the order still submits
 * `PlaceOrderSchema` and the server snapshots a fresh `Address` row, so saved
 * addresses never become order records.
 */
export default function SavedAddressSelector({
  onSelect,
}: {
  onSelect: (address: SavedAddressView) => void
}) {
  const [addresses, setAddresses] = useState<SavedAddressView[]>([])
  const [selectedId, setSelectedId] = useState("")
  const didPrefill = useRef(false)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await listAddresses()
      if (cancelled || !result.ok) return
      const views = result.data.map(toSavedAddressView)
      setAddresses(views)

      // The default address pre-fills the form once; later edits are the
      // shopper's and are never overwritten.
      if (!didPrefill.current) {
        didPrefill.current = true
        const fallback = views.find((address) => address.isDefault) ?? views[0]
        if (fallback) {
          setSelectedId(fallback.id)
          onSelectRef.current(fallback)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (addresses.length === 0) return null

  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <label
        htmlFor="saved-address-select"
        className="block text-sm font-medium text-gray-900 dark:text-white"
      >
        Use a saved address
      </label>
      <select
        id="saved-address-select"
        data-testid="saved-address-select"
        className="mt-2 block w-full rounded-md border border-gray-300 bg-transparent px-3 py-2 text-sm dark:border-gray-700"
        value={selectedId}
        onChange={(event) => {
          const id = event.target.value
          setSelectedId(id)
          const address = addresses.find((candidate) => candidate.id === id)
          if (address) onSelectRef.current(address)
        }}
      >
        <option value="">Enter a new address</option>
        {addresses.map((address) => (
          <option key={address.id} value={address.id}>
            {address.label ? `${address.label} — ` : ""}
            {address.firstName} {address.lastName}, {address.line1}, {address.area}
            {address.isDefault ? " (default)" : ""}
          </option>
        ))}
      </select>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Editing these fields only changes this order. Manage saved addresses in{" "}
        <a href="/account/addresses" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
          your account
        </a>
        .
      </p>
    </div>
  )
}
