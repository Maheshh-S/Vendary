import { z } from "zod";

import { isAllowedImageUrl } from "@/lib/images";

export const MAX_PRODUCT_IMAGES = 8;

export const imageSchema = z.object({
  url: z
    .string()
    .trim()
    .max(2048, "Image URL is too long")
    .refine(isAllowedImageUrl, "Image URL must use https and an allowed host"),
  isMain: z.boolean().default(false),
});

const imagesArraySchema = z
  .array(imageSchema)
  .min(1, "Add at least one image")
  .max(MAX_PRODUCT_IMAGES, `Add at most ${MAX_PRODUCT_IMAGES} images`);

const atMostOneMainImage = (images: { isMain: boolean }[]) =>
  images.filter((image) => image.isMain).length <= 1;

const MAIN_IMAGE_ISSUE = {
  message: "Only one image can be marked as the main image",
  path: ["images"],
};

/** Client form boundary: same rules the action enforces server-side. */
export const imageFormSchema = z
  .object({ images: imagesArraySchema })
  .refine(({ images }) => atMostOneMainImage(images), MAIN_IMAGE_ISSUE);

/** Server boundary: the product id is untrusted too. */
export const addImagesInputSchema = z
  .object({
    productId: z.string().min(1, "Product id is required").max(64, "Product id is invalid"),
    images: imagesArraySchema,
  })
  .refine(({ images }) => atMostOneMainImage(images), MAIN_IMAGE_ISSUE);

export type ImageFormValues = z.infer<typeof imageFormSchema>;
