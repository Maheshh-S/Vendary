"use server"

import { revalidatePath } from "next/cache"

import { requireUser } from "@/lib/auth-guards"
import { prisma } from "@/lib/db/prisma"
import { AppError } from "@/lib/errors"
import { runAction } from "@/lib/run-action"
import { parseInput } from "@/lib/validation"
import {
  MAX_SAVED_ADDRESSES,
  SavedAddressIdSchema,
  SavedAddressInputSchema,
  UpdateSavedAddressSchema,
  type SavedAddressInput,
  type UpdateSavedAddressInput,
} from "@/schemas/account/address-schema"

const ADDRESS_BOOK_PATH = "/account/addresses"

const DEFAULT_CONFLICT_MESSAGE =
  "You already have a default address; refresh and try again."

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "P2002"

/**
 * The partial unique index on `SavedAddress(userId) WHERE isDefault` allows a
 * single default row per user. Two concurrent writers can both clear then
 * write; the loser gets P2002 and is told to refresh instead of seeing an
 * internal error.
 */
const throwIfDefaultConflict = (error: unknown): never => {
  if (isUniqueViolation(error)) {
    throw new AppError("CONFLICT", DEFAULT_CONFLICT_MESSAGE)
  }
  throw error
}

/**
 * Lists the signed-in user's address book. Every query below filters on
 * `session.user.id`: a foreign id is indistinguishable from a missing one and
 * surfaces as NOT_FOUND.
 */
export const listAddresses = async () =>
  runAction("account.listAddresses", async () => {
    const session = await requireUser()
    return prisma.savedAddress.findMany({
      where: { userId: session.user.id },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    })
  })

/**
 * Creates an address. The first saved address becomes the default
 * automatically. The cap is checked inside the same transaction as the insert
 * so a burst of clicks cannot exceed it in normal use.
 */
export const createAddress = async (input: SavedAddressInput) =>
  runAction("account.createAddress", async () => {
    const session = await requireUser()
    const data = parseInput(SavedAddressInputSchema, input)

    const created = await prisma
      .$transaction(async (tx) => {
        const count = await tx.savedAddress.count({
          where: { userId: session.user.id },
        })
        if (count >= MAX_SAVED_ADDRESSES) {
          throw new AppError(
            "CONFLICT",
            `You can save up to ${MAX_SAVED_ADDRESSES} addresses. Delete one to add another.`
          )
        }

        const makeDefault = data.isDefault || count === 0
        if (makeDefault) {
          // One default per user: clear the old one and the insert commit (or
          // roll back) together.
          await tx.savedAddress.updateMany({
            where: { userId: session.user.id, isDefault: true },
            data: { isDefault: false },
          })
        }

        return tx.savedAddress.create({
          data: { ...data, userId: session.user.id, isDefault: makeDefault },
        })
      })
      .catch(throwIfDefaultConflict)

    revalidatePath(ADDRESS_BOOK_PATH)
    return created
  })

/** Updates one owned address; setting `isDefault` clears the previous default. */
export const updateAddress = async (input: UpdateSavedAddressInput) =>
  runAction("account.updateAddress", async () => {
    const session = await requireUser()
    const { id, ...data } = parseInput(UpdateSavedAddressSchema, input)

    const updated = await prisma
      .$transaction(async (tx) => {
        const existing = await tx.savedAddress.findFirst({
          where: { id, userId: session.user.id },
          select: { id: true },
        })
        if (!existing) {
          throw new AppError("NOT_FOUND", "Address not found.")
        }

        if (data.isDefault) {
          await tx.savedAddress.updateMany({
            where: {
              userId: session.user.id,
              isDefault: true,
              id: { not: id },
            },
            data: { isDefault: false },
          })
        }

        return tx.savedAddress.update({
          where: { id },
          // Cleared optional inputs normalize to `undefined`, which Prisma
          // omits from an update. Map them to null so blanking label/line 2/
          // landmark actually clears the stored value.
          data: {
            ...data,
            label: data.label ?? null,
            line2: data.line2 ?? null,
            landmark: data.landmark ?? null,
          },
        })
      })
      .catch(throwIfDefaultConflict)

    revalidatePath(ADDRESS_BOOK_PATH)
    return updated
  })

/** Makes one owned address the default, clearing the previous one atomically. */
export const setDefaultAddress = async (id: string) =>
  runAction("account.setDefaultAddress", async () => {
    const session = await requireUser()
    const addressId = parseInput(SavedAddressIdSchema, id)

    const updated = await prisma
      .$transaction(async (tx) => {
        const existing = await tx.savedAddress.findFirst({
          where: { id: addressId, userId: session.user.id },
          select: { id: true },
        })
        if (!existing) {
          throw new AppError("NOT_FOUND", "Address not found.")
        }

        await tx.savedAddress.updateMany({
          where: { userId: session.user.id, isDefault: true, id: { not: addressId } },
          data: { isDefault: false },
        })

        return tx.savedAddress.update({
          where: { id: addressId },
          data: { isDefault: true },
        })
      })
      .catch(throwIfDefaultConflict)

    revalidatePath(ADDRESS_BOOK_PATH)
    return updated
  })

/**
 * Deletes one owned address. `deleteMany` with both predicates is the
 * ownership check: a foreign row matches zero and never gets deleted.
 */
export const deleteAddress = async (id: string) =>
  runAction("account.deleteAddress", async () => {
    const session = await requireUser()
    const addressId = parseInput(SavedAddressIdSchema, id)

    const result = await prisma.savedAddress.deleteMany({
      where: { id: addressId, userId: session.user.id },
    })
    if (result.count === 0) {
      throw new AppError("NOT_FOUND", "Address not found.")
    }

    revalidatePath(ADDRESS_BOOK_PATH)
    return { id: addressId }
  })
