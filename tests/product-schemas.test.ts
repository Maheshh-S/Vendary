import { describe, expect, it } from "vitest";

import {
  PRODUCT_SORTS,
  productsQuerySchema,
} from "@/schemas/products/products-query-schema";
import { searchProductsSchema } from "@/schemas/products/search-schema";

/**
 * Public catalog schemas (Task 0.8). These are pure Zod contracts: the search
 * term is trimmed and bounded, and the products query coerces URL/string
 * numbers while defaulting every omitted field.
 */

const parseSearch = (input: unknown) => searchProductsSchema.safeParse(input);
const parseQuery = (input: unknown) => productsQuerySchema.safeParse(input);

const searchTerm = (input: unknown): string => {
  const result = parseSearch(input);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("Expected the search schema to accept the input");
  }
  return result.data.query;
};

const query = (input: unknown) => {
  const result = parseQuery(input);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("Expected the products query schema to accept the input");
  }
  return result.data;
};

describe("searchProductsSchema", () => {
  it("trims the query before validating and returns the trimmed term", () => {
    expect(searchTerm({ query: "  shawl  " })).toBe("shawl");
  });

  it("accepts the two-character minimum boundary", () => {
    expect(searchTerm({ query: "ab" })).toBe("ab");
    expect(searchTerm({ query: "  ab  " })).toBe("ab");
  });

  it("accepts the 64-character maximum boundary", () => {
    expect(searchTerm({ query: "x".repeat(64) })).toHaveLength(64);
  });

  it("rejects queries that are shorter than two characters after trimming", () => {
    for (const input of [{ query: "" }, { query: "a" }, { query: "  a  " }, { query: "   " }]) {
      expect(parseSearch(input).success).toBe(false);
    }
  });

  it("rejects queries longer than 64 characters", () => {
    expect(parseSearch({ query: "x".repeat(65) }).success).toBe(false);
    expect(parseSearch({ query: "x".repeat(1000) }).success).toBe(false);
  });

  it("rejects missing and non-string queries", () => {
    expect(parseSearch({}).success).toBe(false);
    expect(parseSearch({ query: 123 }).success).toBe(false);
    expect(parseSearch(null).success).toBe(false);
  });
});

describe("productsQuerySchema", () => {
  it("defaults page, pageSize and sort when everything is omitted", () => {
    expect(query({})).toEqual({
      page: 1,
      pageSize: 24,
      sort: "newest",
    });
  });

  it("coerces numeric strings from the URL", () => {
    const data = query({ page: "3", pageSize: "48" });
    expect(data.page).toBe(3);
    expect(data.pageSize).toBe(48);
  });

  it("accepts the pageSize boundaries", () => {
    expect(query({ pageSize: 1 }).pageSize).toBe(1);
    expect(query({ pageSize: 48 }).pageSize).toBe(48);
  });

  it("trims the optional category and leaves it absent by default", () => {
    expect(query({}).category).toBeUndefined();
    expect(query({ category: "  Pottery  " }).category).toBe("Pottery");
    expect(query({ category: "" }).category).toBe("");
    expect(query({ category: "c".repeat(60) }).category).toHaveLength(60);
  });

  it("accepts every documented sort value", () => {
    expect(PRODUCT_SORTS).toEqual(["newest", "price_asc", "price_desc", "name_asc"]);
    for (const sort of PRODUCT_SORTS) {
      expect(query({ sort }).sort).toBe(sort);
    }
  });

  it.each([
    { label: "zero page", input: { page: 0 } },
    { label: "negative page", input: { page: -1 } },
    { label: "fractional page", input: { page: 1.5 } },
    { label: "fractional page string", input: { page: "2.5" } },
    { label: "non-numeric page", input: { page: "abc" } },
    { label: "null page", input: { page: null } },
    { label: "zero pageSize", input: { pageSize: 0 } },
    { label: "oversized pageSize", input: { pageSize: 49 } },
    { label: "fractional pageSize", input: { pageSize: 24.5 } },
    { label: "non-numeric pageSize", input: { pageSize: "many" } },
    { label: "unknown sort", input: { sort: "cheapest" } },
    { label: "empty sort", input: { sort: "" } },
    { label: "oversized category", input: { category: "c".repeat(61) } },
    { label: "non-string category", input: { category: 42 } },
  ])("rejects $label", ({ input }) => {
    expect(parseQuery(input).success).toBe(false);
  });

  it("still applies the page default when only other fields are supplied", () => {
    expect(query({ pageSize: 10 }).page).toBe(1);
    expect(query({ sort: "name_asc" }).page).toBe(1);
  });
});
