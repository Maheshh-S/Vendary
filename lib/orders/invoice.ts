/** Deterministic invoice math shared by the invoice page and its unit tests. */

export type InvoiceItemLike = {
  /** Stored item snapshot price in rupees. */
  price: number | string | { toString(): string }
  quantity: number
}

export type InvoiceAmounts = {
  subtotalPaise: number
  taxPaise: number
  totalPaise: number
  /** True when the stored total equals the sum of the line snapshots + tax. */
  balanced: boolean
}

export const toPaise = (rupees: number | string | { toString(): string }): number =>
  Math.round(Number(rupees) * 100)

/**
 * Subtotal is derived from the immutable item snapshots; tax and total come
 * from the stored order (the amounts that were charged). `balanced` surfaces a
 * drift between them for tests/monitoring without changing what is rendered.
 */
export const computeInvoiceTotals = (order: {
  items: InvoiceItemLike[]
  taxAmount: number | string | { toString(): string }
  total: number | string | { toString(): string }
}): InvoiceAmounts => {
  const subtotalPaise = order.items.reduce(
    (sum, item) => sum + toPaise(item.price) * item.quantity,
    0
  )
  const taxPaise = toPaise(order.taxAmount)
  const totalPaise = toPaise(order.total)

  return {
    subtotalPaise,
    taxPaise,
    totalPaise,
    balanced: subtotalPaise + taxPaise === totalPaise,
  }
}

/** `INV-{YYYY}-{first 8 chars of the order id}`, per the phase plan. */
export const invoiceNumber = (orderId: string, year: number): string =>
  `INV-${year}-${orderId.slice(0, 8)}`

// Invoices are Indian tax documents: derive the year in IST so an order placed
// on Dec 31 in UTC but after midnight in India gets the new financial year.
const invoiceYearFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
})

export const invoiceYear = (createdAt: Date | string): number =>
  Number(invoiceYearFormatter.format(new Date(createdAt)))
