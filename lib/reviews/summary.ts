import { prisma } from "@/lib/db/prisma";

export type RatingSummary = {
  /** Mean rating over every review, 0 when there are none. */
  average: number;
  /** Total reviews in the database, not just the page's loaded rows. */
  count: number;
  /** Index 0 = one star, index 4 = five stars. */
  counts: number[];
};

export const EMPTY_RATING_SUMMARY: RatingSummary = {
  average: 0,
  count: 0,
  counts: [0, 0, 0, 0, 0],
};

/**
 * Rating summary for a product. Uses `aggregate`/`groupBy` over the whole
 * table: the page only renders the ten newest reviews, so deriving the average
 * from those rows would misreport products with more history.
 */
export const getRatingSummary = async (productId: string): Promise<RatingSummary> => {
  const [aggregate, groups] = await Promise.all([
    prisma.review.aggregate({
      where: { productId },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    prisma.review.groupBy({
      by: ["rating"],
      where: { productId },
      _count: { _all: true },
    }),
  ]);

  const counts = [0, 0, 0, 0, 0];
  for (const group of groups) {
    if (group.rating >= 1 && group.rating <= 5) {
      counts[group.rating - 1] = group._count._all;
    }
  }

  return {
    average: aggregate._avg.rating ?? 0,
    count: aggregate._count._all,
    counts,
  };
};
