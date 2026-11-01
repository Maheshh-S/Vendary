"use client";

import { useState } from "react";
import toast from "react-hot-toast";

import useCart from "@/hooks/use-cart";

type Props = {
  productId: string;
  name: string;
  image: string | null;
  /** Rupees from the catalog; the cart stores integer paise. */
  price: number;
  disabled?: boolean;
};

/** Adds a saved product (quantity 1) to the local cart. */
export default function WishlistCartButton({ productId, name, image, price, disabled }: Props) {
  const { addItem } = useCart();
  const [added, setAdded] = useState(false);

  const onClick = () => {
    const ok = addItem({
      id: productId,
      name,
      unitPaise: Math.round(price * 100),
      quantity: 1,
      images: image ? [{ src: image }] : [],
    });
    if (!ok) return;

    setAdded(true);
    toast.success("Added to cart", { id: `wishlist-cart-${productId}` });
    window.setTimeout(() => setAdded(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
    >
      {added ? "Added" : "Add to cart"}
    </button>
  );
}
