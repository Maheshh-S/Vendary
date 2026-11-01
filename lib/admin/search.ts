import type { Prisma } from "@prisma/client";

/**
 * Admin dashboard search/pagination helpers (Task 1.6).
 *
 * The dashboard is single-store: every ADMIN sees every product and order.
 * `Product.userId` is creator audit only and never appears in these `where`
 * clauses — the regression this module is tested against.
 */

export const ADMIN_PAGE_SIZE = 50;
export const MAX_ADMIN_PAGE = 10_000;
export const MAX_ADMIN_QUERY_LENGTH = 100;

export type AdminSearchQuery = {
  q?: string;
  page: number;
};

type RawSearchParams = {
  q?: string | string[];
  page?: string | string[];
};

const firstValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Sanitizes URL state instead of failing the page: an over-long term drops the
 * search, and an out-of-range page falls back to 1.
 */
export const parseAdminSearchQuery = (params: RawSearchParams): AdminSearchQuery => {
  const rawQuery = firstValue(params.q)?.trim();
  const q =
    rawQuery && rawQuery.length > 0 && rawQuery.length <= MAX_ADMIN_QUERY_LENGTH
      ? rawQuery
      : undefined;

  const rawPage = Number(firstValue(params.page));
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= MAX_ADMIN_PAGE ? rawPage : 1;

  return { q, page };
};

/** Products: name or tag contains the term. */
export const buildAdminProductWhere = (q?: string): Prisma.ProductWhereInput =>
  q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { tag: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};

/** Orders: id, payment id or customer email contains the term. */
export const buildAdminOrderWhere = (q?: string): Prisma.OrderWhereInput =>
  q
    ? {
        OR: [
          { id: { contains: q, mode: "insensitive" } },
          { paymentId: { contains: q, mode: "insensitive" } },
          { user: { email: { contains: q, mode: "insensitive" } } },
        ],
      }
    : {};

export const adminSkip = (page: number): number => (page - 1) * ADMIN_PAGE_SIZE;

/** `/admin` URL preserving the search term; page 1 is the bare list. */
export const adminHref = (page: number, q?: string): string => {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const queryString = params.toString();
  return queryString ? `/admin?${queryString}` : "/admin";
};
