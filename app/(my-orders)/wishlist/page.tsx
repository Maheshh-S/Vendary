import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getWishlist, type WishlistItemView } from "@/actions/wishlist";
import { auth } from "@/auth";
import { formatINR } from "@/lib/format-inr";
import { isAllowedImageUrl } from "@/lib/images";
import WishlistButton from "@/modules/products/components/wishlist-button";
import WishlistCartButton from "@/modules/products/components/wishlist-cart-button";

export const metadata = { title: "Wishlist | Vendary" };

const isPurchasable = (item: WishlistItemView): boolean =>
  item.availability === "IN_STOCK" && item.stockQty > 0;

function WishlistRow({ item }: { item: WishlistItemView }) {
  const purchasable = isPurchasable(item);
  const imageSrc = item.thumbnail && isAllowedImageUrl(item.thumbnail) ? item.thumbnail : null;

  return (
    <li className="flex items-center gap-4 p-4">
      {imageSrc ? (
        <Image
          src={imageSrc}
          alt={item.name}
          width={72}
          height={72}
          className="h-[72px] w-[72px] rounded-md object-cover"
        />
      ) : (
        <div className="h-[72px] w-[72px] rounded-md bg-gray-100 dark:bg-gray-800" />
      )}
      <div className="min-w-0 flex-1">
        <Link
          href={`/products/${item.productId}`}
          className="text-sm font-medium text-gray-900 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
        >
          {item.name}
        </Link>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{formatINR(item.price)}</p>
        <p
          className={
            purchasable
              ? "mt-0.5 text-xs font-medium text-green-700 dark:text-green-400"
              : "mt-0.5 text-xs font-medium text-red-600 dark:text-red-400"
          }
        >
          {purchasable
            ? item.stockQty <= 5
              ? `Only ${item.stockQty} left`
              : "In stock"
            : item.availability === "PRE_ORDER"
              ? "Pre-order — not yet purchasable"
              : "Out of stock"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <WishlistCartButton
          productId={item.productId}
          name={item.name}
          image={item.thumbnail}
          price={item.price}
          disabled={!purchasable}
        />
        <WishlistButton
          productId={item.productId}
          initialInWishlist
          isAuthenticated
          className="size-8"
        />
      </div>
    </li>
  );
}

export default async function WishlistPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const result = await getWishlist();
  const items = result.ok ? result.data : [];
  const available = items.filter(isPurchasable);
  const unavailable = items.filter((item) => !isPurchasable(item));

  return (
    <main className="mx-auto my-8 min-h-screen max-w-3xl px-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">My wishlist</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {items.length === 0
              ? "Save products you want to come back to."
              : `${items.length} saved product${items.length === 1 ? "" : "s"}.`}
          </p>
        </div>
        <Link
          href="/products"
          className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
        >
          Browse products →
        </Link>
      </div>

      {!result.ok ? (
        <p className="mt-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {result.message}
        </p>
      ) : null}

      {items.length === 0 && result.ok ? (
        <div className="mt-10 rounded-lg border border-dashed border-gray-300 p-10 text-center dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Your wishlist is empty. Tap the heart on any product to save it here.
          </p>
          <Link
            href="/products"
            className="mt-4 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Find something you love
          </Link>
        </div>
      ) : null}

      {available.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Ready to buy
          </h2>
          <ul className="mt-3 divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
            {available.map((item) => (
              <WishlistRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ) : null}

      {unavailable.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Currently unavailable
          </h2>
          <ul className="mt-3 divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
            {unavailable.map((item) => (
              <WishlistRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
