"use client";
import React, { useCallback, useEffect } from 'react'
import { useLocalStorage } from '@mantine/hooks';
import toast from 'react-hot-toast';
import {
  CART_STORAGE_KEY,
  MAX_CART_LINES,
  cartTotalPaise,
  clampCartQuantity,
  mergeCartItem,
  normalizeCartItems,
  type CartItem,
} from '@/lib/cart';

export type { CartItem } from '@/lib/cart';

type Props = {
    children: React.ReactNode
}

interface CartContextType {
  items: CartItem[]
  /** Returns false when the line cap rejected the item (the list is unchanged). */
  addItem: (item: CartItem) => boolean
  removeItem: (productId: string) => void
  updateQuantity: (productId: string, quantity: number) => void
  clearCart: () => void
  isOpen: boolean
  setIsOpen: (isOpen: boolean) => void
  /** Sum of every line in integer paise (the server quote's unit). */
  cartTotalPaise: number
}

export const CartContext = React.createContext<CartContextType | undefined>(undefined)

const parseStoredCart = (raw: string | undefined): CartItem[] => {
  if (!raw) return [];
  try {
    return normalizeCartItems(JSON.parse(raw));
  } catch {
    // Corrupt storage is treated as an empty cart; the write-back below
    // replaces it with a valid (empty) array.
    return [];
  }
};

const CartProvider = ({ children }: Props) => {
  const [items, setItems] = useLocalStorage<CartItem[]>({
    key: CART_STORAGE_KEY,
    defaultValue: [],
    // Accepts both the paise shape and the legacy rupee `price` shape.
    deserialize: parseStoredCart,
    serialize: (value) => JSON.stringify(value),
  });

  const [isOpen, setIsOpen] = useLocalStorage<boolean>({
    key: 'cart-is-open',
    defaultValue: false
  });

  // One-time write-back so a legacy `price` cart is persisted in the paise
  // shape after the first read (the migrator itself is pure).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CART_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      const normalized = normalizeCartItems(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
        window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(normalized));
      }
    } catch {
      // Storage unavailable or corrupt: the in-memory cart is already safe.
    }
  }, []);

  const addItem = useCallback((item: CartItem): boolean => {
    const [normalized] = normalizeCartItems([item]);
    if (!normalized) return false;

    // A 51st distinct line would be rejected by the shared server cap, so the
    // cart is left unchanged and the drawer stays closed with an explanation.
    // Quantity updates for an existing line are always allowed.
    const isNewLine = !items.some((existing) => existing.id === normalized.id);
    if (isNewLine && items.length >= MAX_CART_LINES) {
      toast.error(`Your cart is full (${MAX_CART_LINES} items).`);
      return false;
    }

    // Functional write-back: two adds in the same tick both apply to the
    // latest list instead of the render-closure snapshot. `mergeCartItem`
    // re-checks the line cap inside the updater, so the cap still holds even
    // when the closure above is stale.
    setItems((prev) => mergeCartItem(prev, normalized));
    setIsOpen(true);
    return true;
  }, [items, setItems, setIsOpen]);
  
  const removeItem = useCallback((productId: string) => {
    setItems((prevItems) => {
      const existingItem = prevItems.find((prevItem) => productId === prevItem.id);
      if (existingItem) {
        return prevItems.filter((prevItem) => prevItem.id !== productId);
      }
      return prevItems;
    });
  }, [setItems]);

  const updateQuantity = useCallback((productId: string, quantity: number) => {
    if (quantity <= 0) {
      removeItem(productId);
      return;
    }

    setItems((prevItems) => {
      const existingItem = prevItems.find((prevItem) => productId === prevItem.id);
      if (existingItem) {
        return prevItems.map((prevItem) =>
          prevItem.id === productId
            ? {
                ...prevItem,
                quantity: clampCartQuantity(quantity),
              }
            : prevItem
        );
      }
      return prevItems;
    });
  }, [removeItem, setItems]);

  const clearCart = useCallback(() => {
    setItems([]);
    setIsOpen(false);
  }, [setItems, setIsOpen]);

  const totalPaise = cartTotalPaise(items);

  return (
    <CartContext.Provider value={{ items, addItem, removeItem, updateQuantity, clearCart, isOpen, setIsOpen, cartTotalPaise: totalPaise }}>
      {children}
    </CartContext.Provider>
  );
};

export default CartProvider;
