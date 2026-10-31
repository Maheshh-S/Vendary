import { z } from "zod";

export const deleteProductSchema = z.object({
  productId: z.string().min(1, "Product id is required").max(64, "Product id is invalid"),
});
