/** Plain, serializable saved-address shape for client components. */
export type SavedAddressView = {
  id: string
  label: string | null
  firstName: string
  lastName: string
  phone: string
  line1: string
  line2: string | null
  area: string
  landmark: string | null
  state: string
  postalCode: string
  country: string
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

type SavedAddressRow = Omit<SavedAddressView, "createdAt" | "updatedAt"> & {
  createdAt: Date | string
  updatedAt: Date | string
}

export const toSavedAddressView = (row: SavedAddressRow): SavedAddressView => ({
  ...row,
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
})
