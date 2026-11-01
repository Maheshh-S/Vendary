import { describe, expect, it } from "vitest";

import {
  ADMIN_PAGE_SIZE,
  adminHref,
  adminSkip,
  buildAdminOrderWhere,
  buildAdminProductWhere,
  MAX_ADMIN_PAGE,
  MAX_ADMIN_QUERY_LENGTH,
  parseAdminSearchQuery,
} from "@/lib/admin/search";

/**
 * Task 1.6 — the admin dashboard is single-store. These tests pin the two
 * things that used to be wrong: no `userId` predicate may scope the lists, and
 * the URL `q`/`page` state must sanitize rather than 500.
 */

describe("parseAdminSearchQuery", () => {
  it("defaults to page 1 with no search", () => {
    expect(parseAdminSearchQuery({})).toEqual({ q: undefined, page: 1 });
  });

  it("keeps a valid term and page", () => {
    expect(parseAdminSearchQuery({ q: "  vase  ", page: "3" })).toEqual({
      q: "vase",
      page: 3,
    });
  });

  it("uses the first value when a param is repeated", () => {
    expect(parseAdminSearchQuery({ q: ["vase", "bowl"], page: ["2", "4"] })).toEqual({
      q: "vase",
      page: 2,
    });
  });

  it.each([
    ["blank", ""],
    ["whitespace", "   "],
    ["over-long", "x".repeat(MAX_ADMIN_QUERY_LENGTH + 1)],
  ])("drops %s search terms", (_label, q) => {
    expect(parseAdminSearchQuery({ q }).q).toBeUndefined();
  });

  it.each(["0", "-1", "1.5", "abc", String(MAX_ADMIN_PAGE + 1)])(
    "falls back to page 1 for %s",
    (page) => {
      expect(parseAdminSearchQuery({ page }).page).toBe(1);
    }
  );

  it("accepts the maximum page", () => {
    expect(parseAdminSearchQuery({ page: String(MAX_ADMIN_PAGE) }).page).toBe(MAX_ADMIN_PAGE);
  });
});

describe("admin where builders", () => {
  it("shows everything when no search is active", () => {
    expect(buildAdminProductWhere()).toEqual({});
    expect(buildAdminOrderWhere()).toEqual({});
  });

  it("searches products by name or tag only — no userId scoping", () => {
    const where = buildAdminProductWhere("vase");

    expect(where).toEqual({
      OR: [
        { name: { contains: "vase", mode: "insensitive" } },
        { tag: { contains: "vase", mode: "insensitive" } },
      ],
    });
    // A second admin must see products created by the first.
    expect(JSON.stringify(where)).not.toContain("userId");
  });

  it("searches orders by id, payment id or customer email only", () => {
    const where = buildAdminOrderWhere("admin@vendary.test");

    expect(where).toEqual({
      OR: [
        { id: { contains: "admin@vendary.test", mode: "insensitive" } },
        { paymentId: { contains: "admin@vendary.test", mode: "insensitive" } },
        { user: { email: { contains: "admin@vendary.test", mode: "insensitive" } } },
      ],
    });
    // Orders are not scoped to the signed-in admin either.
    expect(JSON.stringify(where)).not.toContain("userId");
  });
});

describe("admin pagination helpers", () => {
  it("pages by 50 rows", () => {
    expect(ADMIN_PAGE_SIZE).toBe(50);
    expect(adminSkip(1)).toBe(0);
    expect(adminSkip(2)).toBe(50);
    expect(adminSkip(3)).toBe(100);
  });

  it("preserves q and page in links", () => {
    expect(adminHref(1)).toBe("/admin");
    expect(adminHref(1, "vase")).toBe("/admin?q=vase");
    expect(adminHref(2, "vase")).toBe("/admin?q=vase&page=2");
    // URLSearchParams encodes search terms safely.
    expect(adminHref(2, "a&b")).toBe("/admin?q=a%26b&page=2");
  });
});
