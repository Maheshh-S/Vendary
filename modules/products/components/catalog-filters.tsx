"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { PRODUCT_SORTS, type ProductSort } from "@/schemas/products/products-query-schema";

const SORT_LABELS: Record<ProductSort, string> = {
  newest: "Newest",
  price_asc: "Price: low to high",
  price_desc: "Price: high to low",
  name_asc: "Name: A–Z",
};

type Props = {
  category?: string;
  sort: ProductSort;
  /** Sanitized rupee strings from the URL (undefined when absent/invalid). */
  minRupees?: string;
  maxRupees?: string;
};

/**
 * URL-driven catalog controls. Every change writes a fresh `/products` URL
 * (dropping `page` so filters always start at page 1) and lets the server
 * component re-query; no catalog state lives in React.
 */
export default function CatalogFilters({ category, sort, minRupees, maxRupees }: Props) {
  const router = useRouter();
  const [sortValue, setSortValue] = useState<ProductSort>(sort);
  const [min, setMin] = useState(minRupees ?? "");
  const [max, setMax] = useState(maxRupees ?? "");

  // Back/forward navigation re-renders this server page with new props; keep
  // the controlled inputs in sync instead of showing the previous URL's state.
  useEffect(() => {
    setSortValue(sort);
    setMin(minRupees ?? "");
    setMax(maxRupees ?? "");
  }, [sort, minRupees, maxRupees]);

  const navigate = (next: { sort?: ProductSort; min?: string; max?: string }) => {
    const params = new URLSearchParams();
    if (category) params.set("category", category);

    const nextSort = next.sort ?? sortValue;
    if (nextSort !== "newest") params.set("sort", nextSort);

    const nextMin = (next.min ?? min).trim();
    const nextMax = (next.max ?? max).trim();
    if (nextMin !== "") params.set("min", nextMin);
    if (nextMax !== "") params.set("max", nextMax);

    const queryString = params.toString();
    router.push(queryString ? `/products?${queryString}` : "/products");
  };

  return (
    <div className="mt-6 flex flex-col gap-4 border-b border-zinc-200 pb-4 sm:flex-row sm:items-end sm:justify-between dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <label
          htmlFor="catalog-sort"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Sort
        </label>
        <select
          id="catalog-sort"
          aria-label="Sort products"
          value={sortValue}
          onChange={(event) => {
            const nextSort = event.target.value as ProductSort;
            setSortValue(nextSort);
            navigate({ sort: nextSort });
          }}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
        >
          {PRODUCT_SORTS.map((option) => (
            <option key={option} value={option}>
              {SORT_LABELS[option]}
            </option>
          ))}
        </select>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({});
        }}
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Min (₹)
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={min}
            onChange={(event) => setMin(event.target.value)}
            className="w-28 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Max (₹)
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={max}
            onChange={(event) => setMax(event.target.value)}
            className="w-28 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
          />
        </label>
        <Button type="submit" color="light" className="px-4">
          Apply
        </Button>
        {(min !== "" || max !== "") && (
          <Button
            type="button"
            plain
            onClick={() => {
              setMin("");
              setMax("");
              navigate({ min: "", max: "" });
            }}
          >
            Clear
          </Button>
        )}
      </form>
    </div>
  );
}
