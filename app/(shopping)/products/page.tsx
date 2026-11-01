import { GetProducts } from "@/actions/products/products";
import {
  Pagination,
  PaginationGap,
  PaginationList,
  PaginationNext,
  PaginationPage,
  PaginationPrevious,
} from "@/components/ui/pagination";
import ProductCard from "@/modules/products/components/product-card";
import CatalogFilters from "@/modules/products/components/catalog-filters";
import {
  MAX_PRODUCTS_PAGE,
  PRODUCT_SORTS,
  type ProductSort,
} from "@/schemas/products/products-query-schema";

type SearchParams = {
  category?: string | string[];
  page?: string | string[];
  sort?: string | string[];
  min?: string | string[];
  max?: string | string[];
};

type Props = {
  searchParams: Promise<SearchParams>;
};

const MAX_CATEGORY_LENGTH = 60;
/**
 * Display page size. Smaller than the action default (24) so the 4-column
 * grid stays three rows tall and a small catalog is still paginated.
 */
const PAGE_SIZE = 12;

const firstValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Invalid URL values fall back to defaults instead of failing the page. */
const parsePage = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PRODUCTS_PAGE ? parsed : 1;
};

const parseCategory = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= MAX_CATEGORY_LENGTH ? trimmed : undefined;
};

const parseSort = (value: string | undefined): ProductSort =>
  PRODUCT_SORTS.find((sort) => sort === value) ?? "newest";

/**
 * URL prices are human-facing rupees; the action takes paise. Empty or invalid
 * values are dropped so a hand-edited URL degrades to "no filter".
 */
const parseRupeesToPaise = (value: string | undefined): number | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const rupees = Number(trimmed);
  if (!Number.isFinite(rupees) || rupees < 0) return undefined;
  const paise = Math.round(rupees * 100);
  return Number.isSafeInteger(paise) ? paise : undefined;
};

const rupeesParam = (paise: number | undefined): string | undefined =>
  paise === undefined ? undefined : (paise / 100).toFixed(2);

type CatalogFiltersState = {
  category?: string;
  sort: ProductSort;
  min?: number;
  max?: number;
};

const productsHref = (targetPage: number, filters: CatalogFiltersState): string => {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (filters.min !== undefined) params.set("min", (filters.min / 100).toFixed(2));
  if (filters.max !== undefined) params.set("max", (filters.max / 100).toFixed(2));
  if (targetPage > 1) params.set("page", String(targetPage));
  const queryString = params.toString();
  return queryString ? `/products?${queryString}` : "/products";
};

/** 1 … current-1, current, current+1 … last — with gaps for long catalogs. */
const pageWindow = (page: number, totalPages: number): (number | "gap")[] => {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const wanted = new Set([1, totalPages, page - 1, page, page + 1]);
  const sorted = Array.from(wanted)
    .filter((candidate) => candidate >= 1 && candidate <= totalPages)
    .sort((a, b) => a - b);

  const items: (number | "gap")[] = [];
  let previous = 0;
  for (const candidate of sorted) {
    if (previous !== 0 && candidate - previous > 1) items.push("gap");
    items.push(candidate);
    previous = candidate;
  }
  return items;
};

export default async function ProductsPage({ searchParams }: Props) {
  const params = await searchParams;
  const category = parseCategory(firstValue(params.category));
  const page = parsePage(firstValue(params.page));
  const sort = parseSort(firstValue(params.sort));

  let minPricePaise = parseRupeesToPaise(firstValue(params.min));
  let maxPricePaise = parseRupeesToPaise(firstValue(params.max));
  // An inverted range is a bad URL, not an error page: drop both bounds.
  if (minPricePaise !== undefined && maxPricePaise !== undefined && minPricePaise > maxPricePaise) {
    minPricePaise = undefined;
    maxPricePaise = undefined;
  }

  const result = await GetProducts({
    page,
    pageSize: PAGE_SIZE,
    category,
    sort,
    minPricePaise,
    maxPricePaise,
  });

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

  const { items, total, totalPages, page: currentPage, pageSize } = result.data;
  const filters: CatalogFiltersState = {
    category,
    sort,
    min: minPricePaise,
    max: maxPricePaise,
  };
  const start = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, total);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 lg:max-w-7xl">
      <h1 className="text-2xl font-bold">{heading}</h1>

      <CatalogFilters
        category={category}
        sort={sort}
        minRupees={rupeesParam(minPricePaise)}
        maxRupees={rupeesParam(maxPricePaise)}
      />

      {items.length === 0 ? (
        <p className="mt-10 text-center text-gray-500">
          No products found
          {category ? ` in ${category}` : ""}
          {minPricePaise !== undefined || maxPricePaise !== undefined
            ? " for this price range"
            : ""}
          .
        </p>
      ) : (
        <>
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            Showing {start}–{end} of {total}
          </p>
          <div
            data-testid="product-grid"
            className="mt-4 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 md:grid-cols-3 md:gap-y-0 lg:grid-cols-4 lg:gap-x-8"
          >
            {items.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </>
      )}

      {totalPages > 1 && (
        <Pagination className="mt-10">
          <PaginationPrevious
            href={currentPage > 1 ? productsHref(currentPage - 1, filters) : null}
          />
          <PaginationList>
            {pageWindow(currentPage, totalPages).map((item, index) =>
              item === "gap" ? (
                <PaginationGap key={`gap-${index}`} />
              ) : (
                <PaginationPage
                  key={item}
                  href={productsHref(item, filters)}
                  current={item === currentPage}
                >
                  {item}
                </PaginationPage>
              )
            )}
          </PaginationList>
          <PaginationNext
            href={currentPage < totalPages ? productsHref(currentPage + 1, filters) : null}
          />
        </Pagination>
      )}
    </div>
  );
}
