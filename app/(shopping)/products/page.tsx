import { GetProducts } from "@/actions/products/products";
import {
  Pagination,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import ProductCard from "@/modules/products/components/product-card";
import {
  PRODUCT_SORTS,
  type ProductSort,
} from "@/schemas/products/products-query-schema";

type SearchParams = {
  category?: string | string[];
  page?: string | string[];
  sort?: string | string[];
};

type Props = {
  searchParams: Promise<SearchParams>;
};

const MAX_CATEGORY_LENGTH = 60;

const firstValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Invalid URL values fall back to defaults instead of failing the page. */
const parsePage = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
};

const parseCategory = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= MAX_CATEGORY_LENGTH ? trimmed : undefined;
};

const parseSort = (value: string | undefined): ProductSort =>
  PRODUCT_SORTS.find((sort) => sort === value) ?? "newest";

const productsHref = (
  targetPage: number,
  category: string | undefined,
  sort: ProductSort
): string => {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (sort !== "newest") params.set("sort", sort);
  if (targetPage > 1) params.set("page", String(targetPage));
  const queryString = params.toString();
  return queryString ? `/products?${queryString}` : "/products";
};

export default async function ProductsPage({ searchParams }: Props) {
  const params = await searchParams;
  const category = parseCategory(firstValue(params.category));
  const page = parsePage(firstValue(params.page));
  const sort = parseSort(firstValue(params.sort));

  const result = await GetProducts({ page, category, sort });

  const heading = category
    ? `${category.charAt(0).toUpperCase()}${category.slice(1)}`
    : "All Products";

  if (!result.ok) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 lg:max-w-7xl">
        <h1 className="text-2xl font-bold">{heading}</h1>
        <p className="mt-10 text-center text-gray-500">
          Unable to load products right now. Please try again.
        </p>
      </div>
    );
  }

  const { items, totalPages } = result.data;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 lg:max-w-7xl">
      <h1 className="text-2xl font-bold">{heading}</h1>

      {items.length === 0 ? (
        <p className="mt-10 text-center text-gray-500">
          No products found{category ? ` in ${category}` : ""} yet.
        </p>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 md:grid-cols-3 md:gap-y-0 lg:grid-cols-4 lg:gap-x-8">
          {items.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}

      {items.length > 0 && totalPages > 1 && (
        <Pagination className="mt-10">
          <PaginationPrevious
            href={page > 1 ? productsHref(page - 1, category, sort) : null}
          />
          <PaginationNext
            href={page < totalPages ? productsHref(page + 1, category, sort) : null}
          />
        </Pagination>
      )}
    </div>
  );
}
