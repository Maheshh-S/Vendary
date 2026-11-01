/**
 * Client-safe cart primitives shared by the provider, the pages and tests.
 *
 * Money convention: `unitPaise` is an integer number of paise. Legacy carts
 * (before Phase 1) stored `price` in rupees; `normalizeCartItems` upgrades that
 * shape on read so a stored cart survives the migration without losing items.
 *
 * No server-only imports here — this module is bundled into client components.
 */

export const CART_STORAGE_KEY = "cart-items";

/** Mirrors the per-line quantity bound enforced by the server cart quote. */
export const MAX_CART_QUANTITY = 99;

/**
 * One distinct-line cap shared by the cart provider, the checkout session
 * schema and the server cart quote, so the client can never build a cart the
 * charge path rejects.
 */
export const MAX_CART_LINES = 50;

export type CartImage = { src: string };

export type CartItem = {
  id: string;
  name: string;
  /** Integer paise — never a rupee float. */
  unitPaise: number;
  quantity: number;
  images: CartImage[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Integer paise from a stored `unitPaise`/`price` value, or null when unusable. */
const readUnitPaise = (raw: Record<string, unknown>): number | null => {
  // Current shape: integer paise.
  if (typeof raw.unitPaise === "number" && Number.isFinite(raw.unitPaise)) {
    if (raw.unitPaise < 0) return null;
    return Math.round(raw.unitPaise);
  }

  // Legacy shape: rupees, possibly fractional. Persist the paise equivalent so
  // the next read no longer needs to migrate.
  const legacyPrice =
    typeof raw.price === "number"
      ? raw.price
      : typeof raw.price === "string" && raw.price.trim() !== ""
        ? Number(raw.price)
        : NaN;
  if (!Number.isFinite(legacyPrice) || legacyPrice < 0) {
    return null;
  }
  return Math.round(legacyPrice * 100);
};

const readQuantity = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_CART_QUANTITY, Math.max(1, Math.floor(value)));
};

const readImages = (value: unknown): CartImage[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image) =>
    isRecord(image) && typeof image.src === "string" && image.src !== "" ? [{ src: image.src }] : []
  );
};

/**
 * Normalizes an untrusted localStorage value into the current cart shape.
 * Corrupt rows are dropped (price/quantity unusable), quantities are clamped
 * to 1..99, duplicate product ids are merged, and the result is trimmed to the
 * server's distinct-line cap so totals stay honest and checkout stays valid.
 */
export function normalizeCartItems(value: unknown): CartItem[] {
  if (!Array.isArray(value)) return [];

  const byId = new Map<string, CartItem>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;

    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id) continue;

    const unitPaise = readUnitPaise(entry);
    if (unitPaise === null) continue;

    const name = typeof entry.name === "string" ? entry.name : "";
    const quantity = readQuantity(entry.quantity);
    const images = readImages(entry.images);

    const existing = byId.get(id);
    if (existing) {
      existing.quantity = Math.min(MAX_CART_QUANTITY, existing.quantity + quantity);
      continue;
    }

    byId.set(id, { id, name, unitPaise, quantity, images });
  }

  // A corrupt/legacy cart can exceed the server line cap; trim it on read so
  // the quote (and therefore the payment button) can recover.
  return Array.from(byId.values()).slice(0, MAX_CART_LINES);
}

/** Clamps a user-driven quantity change into the server-valid range. */
export function clampCartQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 1;
  return Math.min(MAX_CART_QUANTITY, Math.max(1, Math.floor(quantity)));
}

/**
 * Adds a normalized item to the cart, merging duplicate ids and clamping the
 * quantity. A cart already at `MAX_CART_LINES` rejects a 51st distinct line
 * (returns the existing list unchanged); quantity updates for an existing
 * line are always allowed.
 */
export function mergeCartItem(items: readonly CartItem[], item: CartItem): CartItem[] {
  const existing = items.find((candidate) => candidate.id === item.id);
  if (existing) {
    return items.map((candidate) =>
      candidate.id === item.id
        ? {
            ...candidate,
            quantity: clampCartQuantity(candidate.quantity + item.quantity),
          }
        : candidate
    );
  }

  if (items.length >= MAX_CART_LINES) {
    return [...items];
  }

  return [...items, item];
}

/** Sum of every line in paise — the same unit the server quote returns. */
export function cartTotalPaise(items: readonly CartItem[]): number {
  return items.reduce((total, item) => total + item.unitPaise * item.quantity, 0);
}
