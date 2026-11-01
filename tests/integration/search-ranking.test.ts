import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { searchCatalog } from "@/lib/search";

/**
 * Task 4.4 — pg_trgm search ranking. Runs only with an explicit
 * `TEST_DATABASE_URL`; otherwise the suite skips so `npx vitest run` never
 * needs a database. Fixtures live in a unique category and are deleted in
 * `afterAll`.
 *
 * Run:
 *   TEST_DATABASE_URL=postgresql://… npx vitest run tests/integration/search-ranking.test.ts
 */

const testUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const hasTestDatabase = testUrl.length > 0;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: testUrl || "postgresql://invalid:invalid@localhost:5432/invalid",
    },
  },
});

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const MADHUBANI_NAME = "Madhubani Fish Motif Painting";
const NEEDLE_PREFIX = `RankingNeedle${suffix}`;

let userId = "";
let categoryId = "";
let madhubaniId = "";
let exactTagId = "";
let nameOnlyId = "";

const productData = (overrides: Record<string, unknown>) => ({
  name: `Search fixture ${suffix}`,
  price: "100.00",
  availability: "IN_STOCK" as const,
  stockQty: 25,
  categoryId,
  userId,
  ...overrides,
});

describe.skipIf(!hasTestDatabase)("pg_trgm search ranking (integration)", () => {
  beforeAll(async () => {
    // Keep the test database schema current; this also creates pg_trgm and the
    // trigram indexes from migration 20270101002000_search_trgm.
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "ignore",
    });

    const user = await prisma.user.create({
      data: {
        email: `search-ranking-${suffix}@vendary.test`,
        name: "Search Ranking",
        role: "USER",
      },
    });
    userId = user.id;

    const category = await prisma.category.create({
      data: { name: `Search Ranking ${suffix}` },
    });
    categoryId = category.id;

    const madhubani = await prisma.product.create({
      data: productData({
        name: MADHUBANI_NAME,
        tag: "Madhubani",
        description: "Hand-painted Madhubani folk art from the Mithila region.",
      }),
    });
    madhubaniId = madhubani.id;

    // Exact tag, but the name never contains "Warli".
    const exactTag = await prisma.product.create({
      data: productData({
        name: `Folk Art Tagged Piece ${suffix}`,
        tag: "Warli",
        description: "Tag-only match fixture.",
      }),
    });
    exactTagId = exactTag.id;

    // Name substring only; the tag must not match.
    const nameOnly = await prisma.product.create({
      data: productData({
        name: `Village Warli Painting ${suffix}`,
        tag: `Folk${suffix}`,
        description: "Name-substring match fixture.",
      }),
    });
    nameOnlyId = nameOnly.id;

    await prisma.product.createMany({
      data: Array.from({ length: 15 }, (_, index) =>
        productData({
          name: `${NEEDLE_PREFIX} item ${index}`,
          tag: NEEDLE_PREFIX,
          description: `Bounded-result fixture ${index}`,
        })
      ),
    });
  }, 120_000);

  afterAll(async () => {
    if (!hasTestDatabase) return;

    if (categoryId) {
      await prisma.product.deleteMany({ where: { categoryId } });
      await prisma.category.deleteMany({ where: { id: categoryId } });
    }
    if (userId) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma.$disconnect();
  });

  it("creates the trigram GIN indexes", async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'Product'
        AND indexname IN (
          'Product_name_trgm_idx',
          'Product_tag_trgm_idx',
          'Product_description_trgm_idx'
        )
      ORDER BY indexname
    `;

    expect(indexes.map((row) => row.indexname)).toEqual([
      "Product_description_trgm_idx",
      "Product_name_trgm_idx",
      "Product_tag_trgm_idx",
    ]);
  });

  it("uses the trigram indexes for the fuzzy/ILIKE arms", async () => {
    // The fixture table is tiny, so the planner would normally prefer a seq
    // scan. Disable the alternatives inside this transaction to prove the
    // indexes actually cover the production predicates.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
      return tx.$queryRaw<Record<string, string>[]>`
        EXPLAIN SELECT p."id"
        FROM "Product" p
        WHERE p."name" ILIKE ${"%madhuani%"}
           OR p."tag" ILIKE ${"%madhuani%"}
           OR p."description" ILIKE ${"%madhuani%"}
           OR p."name" % ${"madhuani"}
           OR p."tag" % ${"madhuani"}
      `;
    });

    const text = plan.map((row) => Object.values(row)[0]).join("\n");
    expect(text).toContain("Bitmap Index Scan");
    expect(text).toContain("trgm");
  });

  it("ranks the typo'd query to the Madhubani product", async () => {
    const { hits, usedFallback } = await searchCatalog(prisma, "madhuani");

    expect(usedFallback).toBe(false);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(10);
    expect(hits[0]?.name).toContain("Madhubani");
    expect(hits.some((hit) => hit.id === madhubaniId)).toBe(true);
  });

  it("puts exact name and exact tag matches before substring-only matches", async () => {
    const exactName = await searchCatalog(prisma, MADHUBANI_NAME);
    expect(exactName.hits[0]?.name).toBe(MADHUBANI_NAME);
    expect(exactName.hits.some((hit) => hit.id === madhubaniId)).toBe(true);

    const tagQuery = await searchCatalog(prisma, "Warli");
    const exactTagIndex = tagQuery.hits.findIndex((hit) => hit.id === exactTagId);
    const nameOnlyIndex = tagQuery.hits.findIndex((hit) => hit.id === nameOnlyId);
    expect(exactTagIndex).toBeGreaterThanOrEqual(0);
    expect(nameOnlyIndex).toBeGreaterThan(exactTagIndex);
  });

  it("bounds every result set to ten", async () => {
    const { hits } = await searchCatalog(prisma, NEEDLE_PREFIX);
    expect(hits).toHaveLength(10);
  });
});
