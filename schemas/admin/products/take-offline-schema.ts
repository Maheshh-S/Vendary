import { z } from "zod";

/** Mirrors Prisma's `Availability` enum; validated at runtime, not just typed. */
export const availabilitySchema = z.enum(["IN_STOCK", "OUT_OF_STOCK", "PRE_ORDER"]);

export type AvailabilityValue = z.infer<typeof availabilitySchema>;

export const takeOfflineSchema = z.object({
  productId: z.string().min(1, "Product id is required").max(64, "Product id is invalid"),
  availability: availabilitySchema,
});
