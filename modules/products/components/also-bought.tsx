import Image from "next/image";
import Link from "next/link";

import { formatINR } from "@/lib/format-inr";
import type { RecommendationCard } from "@/lib/recommendations";

/**
 * Presentational "Customers also bought" strip for the product detail page
 * (Task 4.5). Server component: the page already resolved and cached the list,
 * so this renders plain links/cards and no client state.
 */
export default function AlsoBought({ products }: { products: readonly RecommendationCard[] }) {
  if (products.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="also-bought-heading"
      className="mx-auto w-full max-w-6xl px-4 pb-10 md:px-6 lg:px-8"
      data-testid="also-bought"
    >
      <h2 id="also-bought-heading" className="text-lg font-semibold text-zinc-900 dark:text-white">
        Customers also bought
      </h2>
      <ul className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {products.map((product) => (
          <li
            key={product.id}
            className="group overflow-hidden rounded-lg border border-zinc-200 bg-white transition-shadow hover:shadow-md dark:border-zinc-700 dark:bg-zinc-800"
          >
            <Link href={`/products/${product.id}`} className="block">
              <div className="aspect-square overflow-hidden bg-zinc-100 dark:bg-zinc-900">
                <Image
                  src={product.imageSrc || "/assets/empty-cart.png"}
                  alt={product.imageAlt || product.name}
                  width={300}
                  height={300}
                  className="h-full w-full object-cover object-center transition-transform group-hover:scale-105"
                  sizes="(min-width: 1024px) 25vw, 50vw"
                />
              </div>
              <div className="p-3">
                <p className="line-clamp-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {product.name}
                </p>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
                  {formatINR(product.price)}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
