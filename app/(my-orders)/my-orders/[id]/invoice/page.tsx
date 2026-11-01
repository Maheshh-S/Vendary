import { notFound, redirect } from "next/navigation"

import { auth } from "@/auth"
import { prisma } from "@/lib/db/prisma"
import { serializePrismaObject } from "@/lib/db/serializer"
import Invoice, { type InvoiceOrderView } from "@/modules/orders/components/invoice"

import "./print.css"

type Props = {
  params: Promise<{ id: string }>
}

export const metadata = { title: "Invoice | Vendary" }

/**
 * Owner-only invoice. Ownership is part of the query so a foreign id is
 * indistinguishable from a missing one (both 404).
 */
export default async function InvoicePage({ params }: Props) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/")
  }

  const order = await prisma.order.findFirst({
    where: { id, userId: session.user.id },
    include: { items: true, address: true },
  })
  if (!order) {
    notFound()
  }

  const view = serializePrismaObject(order) as InvoiceOrderView
  const gstin = process.env.SELLER_GSTIN?.trim() || null

  return <Invoice order={view} gstin={gstin} />
}
