"use client";

import { Badge } from "@/components/ui/badge";
import { formatPrice } from "@/lib/locales";
import { useLocale } from "@/providers/locale-provider";
import Image from "next/image";
import Link from "next/link";

export type ProductCardData = {
  id: string;
  name: string;
  tag: string | null;
  imageSrc: string | null;
  price: number;
  imageAlt: string | null;
};

function truncateText(text: string | null, maxLength: number = 20) {
  if (!text) return "";
  return text.length > maxLength
    ? text.substring(0, maxLength) + "..."
    : text;
}

export default function ProductCard({ product }: { product: ProductCardData }) {
  const { locale } = useLocale();
  return (
    <div className="group relative">
      <div className="h-42 w-full overflow-hidden rounded-md group-hover:opacity-75 lg:h-52 xl:h-64">
        <Image
          height={300}
          width={300}
          alt={product.imageAlt || "Product image"}
          src={product.imageSrc || "/assets/empty-cart.png"}
          className="size-full aspect-square object-cover object-center bg-gray-500"
          sizes="(min-width: 1024px) 100vw, (min-width: 640px) 50vw, 100vw"
        />
      </div>
      <h3 className="mt-4 text-sm text-gray-700">
        <Link href={`/products/${product.id}`}>
          <span className="absolute inset-0" />
          {truncateText(product.name)}
        </Link>
      </h3>
      <div className="w-full flex justify-between">
        <p className="mt-1 text-sm font-medium text-gray-900">
          {formatPrice(product.price, locale)}
        </p>
        {product.tag && <Badge>{product.tag}</Badge>}
      </div>
    </div>
  );
}