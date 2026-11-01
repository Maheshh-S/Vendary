"use client";

import { Heart } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import toast from "react-hot-toast";

import { toggleWishlist } from "@/actions/wishlist";
import { cn } from "@/lib/utils";

type Props = {
  productId: string;
  initialInWishlist: boolean;
  isAuthenticated: boolean;
  /** Extra positioning/size classes; the button is presentational. */
  className?: string;
};

/**
 * Heart toggle shared by product cards and the product detail page. Guests are
 * sent to login with a `callbackUrl` back to the current page; the server
 * action still requires a session, so a stale client flag cannot write.
 */
export default function WishlistButton({
  productId,
  initialInWishlist,
  isAuthenticated,
  className,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [inWishlist, setInWishlist] = useState(initialInWishlist);
  const [pending, setPending] = useState(false);

  const loginHref = `/login?callbackUrl=${encodeURIComponent(pathname)}`;

  const onClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!isAuthenticated) {
      router.push(loginHref);
      return;
    }
    if (pending) return;

    setPending(true);
    const result = await toggleWishlist(productId);
    setPending(false);

    if (!result.ok) {
      if (result.code === "UNAUTHORIZED") {
        router.push(loginHref);
        return;
      }
      toast.error(result.message, { id: `wishlist-${productId}` });
      return;
    }

    setInWishlist(result.data.added);
    toast.success(result.data.added ? "Saved to wishlist" : "Removed from wishlist", {
      id: `wishlist-${productId}`,
    });
    // Refresh the current route so the wishlist page drops a removed row.
    router.refresh();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-pressed={inWishlist}
      aria-label={inWishlist ? "Remove from wishlist" : "Add to wishlist"}
      title={inWishlist ? "Remove from wishlist" : "Add to wishlist"}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-full border border-zinc-200 bg-white/90 text-zinc-600 shadow-sm backdrop-blur transition-colors hover:bg-white hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-300 dark:hover:bg-zinc-900",
        className
      )}
    >
      <Heart
        aria-hidden="true"
        className={cn("size-5", inWishlist && "fill-rose-500 text-rose-500")}
      />
    </button>
  );
}
