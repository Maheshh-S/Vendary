import { afterEach, describe, expect, it, vi } from "vitest";

import { ALLOWED_IMAGE_HOSTS, isAllowedImageUrl } from "@/lib/images";
import {
  addImagesInputSchema,
  imageFormSchema,
} from "@/schemas/admin/products/add-image-schema";
import {
  createProductSchema,
  productFormSchema,
  type ProductFormValues,
} from "@/schemas/admin/products/create-product-schema";
import { deleteProductSchema } from "@/schemas/admin/products/delete-product-schema";
import {
  editLongDescriptionSchema,
  editShortDescriptionSchema,
} from "@/schemas/admin/products/edit-description-schema";
import {
  editPriceSchema,
  formatPriceForStorage,
} from "@/schemas/admin/products/edit-price-schema";
import { takeOfflineSchema } from "@/schemas/admin/products/take-offline-schema";

const VALID_PRODUCT_ID = "clx0product0000000000000000";

const accepted = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("lib/images", () => {
  it("exports exactly the hosts next.config derives remotePatterns from", () => {
    expect(ALLOWED_IMAGE_HOSTS).toEqual([
      "images.unsplash.com",
      "images.pexels.com",
      "m.media-amazon.com",
      "pixabay.com",
      "tailwindcss.com",
      "lh3.googleusercontent.com",
    ]);
  });

  it.each(ALLOWED_IMAGE_HOSTS)("accepts an https URL on %s", (host) => {
    expect(isAllowedImageUrl(`https://${host}/photo.jpg`)).toBe(true);
  });

  it("rejects non-https protocols and non-allowlisted hosts", () => {
    for (const url of [
      "http://images.unsplash.com/photo.jpg",
      "ftp://images.unsplash.com/photo.jpg",
      "https://evil.example/photo.jpg",
      "https://images.unsplash.com.evil.example/photo.jpg",
      "https://images.unsplash.com@evil.example/photo.jpg",
      "not-a-url",
      "",
    ]) {
      expect(isAllowedImageUrl(url), url).toBe(false);
    }
  });

  it("allows only http://localhost:3000, and only outside production", () => {
    expect(isAllowedImageUrl("http://localhost:3000/photo.jpg")).toBe(true);
    expect(isAllowedImageUrl("http://localhost:4000/photo.jpg")).toBe(false);
    expect(isAllowedImageUrl("https://localhost:3000/photo.jpg")).toBe(false);

    vi.stubEnv("NODE_ENV", "production");
    expect(isAllowedImageUrl("http://localhost:3000/photo.jpg")).toBe(false);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("editPriceSchema", () => {
  it("accepts a plain rupee price with at most two decimals", () => {
    for (const price of [10.1, "10.1", "10", 1, 10_000_000, " 10.10 "]) {
      const parsed = editPriceSchema.safeParse({ productId: VALID_PRODUCT_ID, price });
      expect(parsed.success, `price ${String(price)}`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.price).toBe(Number(price));
      }
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["-1", -1],
    ["0", 0],
    ["1e12", 1e12],
    ["0.001", 0.001],
    ["10.123", 10.123],
    ["scientific string", "1e3"],
    ["non-numeric string", "abc"],
    ["empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["object", {}],
    ["array", []],
    ["boolean", true],
  ])("rejects fuzz price %s", (_label, price) => {
    expect(accepted(editPriceSchema, { productId: VALID_PRODUCT_ID, price })).toBe(false);
  });

  it("bounds the product id", () => {
    expect(accepted(editPriceSchema, { productId: "", price: 10 })).toBe(false);
    expect(accepted(editPriceSchema, { productId: "x".repeat(65), price: 10 })).toBe(false);
    expect(accepted(editPriceSchema, { productId: "x".repeat(64), price: 10 })).toBe(true);
  });

  it("formats storage prices as a two-decimal string", () => {
    expect(formatPriceForStorage(10.1)).toBe("10.10");
    expect(formatPriceForStorage(1)).toBe("1.00");
    expect(formatPriceForStorage(10_000_000)).toBe("10000000.00");
    expect(formatPriceForStorage(999.999)).toBe("1000.00");
  });
});

describe("edit description schemas", () => {
  it("trims both description fields", () => {
    const short = editShortDescriptionSchema.parse({
      productId: VALID_PRODUCT_ID,
      shortDescription: "  A compact wireless mouse  ",
    });
    expect(short.shortDescription).toBe("A compact wireless mouse");

    const long = editLongDescriptionSchema.parse({
      productId: VALID_PRODUCT_ID,
      longDescription: "  A longer description of the product.  ",
    });
    expect(long.longDescription).toBe("A longer description of the product.");
  });

  it("enforces short description bounds (10-300)", () => {
    const withLength = (length: number) => ({
      productId: VALID_PRODUCT_ID,
      shortDescription: "a".repeat(length),
    });
    expect(accepted(editShortDescriptionSchema, withLength(9))).toBe(false);
    expect(accepted(editShortDescriptionSchema, withLength(10))).toBe(true);
    expect(accepted(editShortDescriptionSchema, withLength(300))).toBe(true);
    expect(accepted(editShortDescriptionSchema, withLength(301))).toBe(false);
    expect(accepted(editShortDescriptionSchema, withLength(0))).toBe(false);
  });

  it("enforces long description bounds (10-5000)", () => {
    const withLength = (length: number) => ({
      productId: VALID_PRODUCT_ID,
      longDescription: "a".repeat(length),
    });
    expect(accepted(editLongDescriptionSchema, withLength(9))).toBe(false);
    expect(accepted(editLongDescriptionSchema, withLength(10))).toBe(true);
    expect(accepted(editLongDescriptionSchema, withLength(5000))).toBe(true);
    expect(accepted(editLongDescriptionSchema, withLength(5001))).toBe(false);
  });

  it("requires a bounded product id on both", () => {
    for (const schema of [editShortDescriptionSchema, editLongDescriptionSchema]) {
      expect(accepted(schema, { productId: "", shortDescription: "a".repeat(20), longDescription: "a".repeat(20) })).toBe(false);
      expect(accepted(schema, { productId: "x".repeat(65), shortDescription: "a".repeat(20), longDescription: "a".repeat(20) })).toBe(false);
    }
  });
});

describe("takeOfflineSchema", () => {
  it.each(["IN_STOCK", "OUT_OF_STOCK", "PRE_ORDER"])("accepts the %s enum value", (availability) => {
    expect(accepted(takeOfflineSchema, { productId: VALID_PRODUCT_ID, availability })).toBe(true);
  });

  it.each(["in_stock", "SOLD_OUT", "", null, 1])("rejects %j", (availability) => {
    expect(accepted(takeOfflineSchema, { productId: VALID_PRODUCT_ID, availability })).toBe(false);
  });

  it("requires a bounded product id", () => {
    expect(accepted(takeOfflineSchema, { productId: "", availability: "IN_STOCK" })).toBe(false);
    expect(accepted(takeOfflineSchema, { productId: "x".repeat(65), availability: "IN_STOCK" })).toBe(false);
  });
});

describe("deleteProductSchema", () => {
  it("requires a bounded product id", () => {
    expect(accepted(deleteProductSchema, { productId: VALID_PRODUCT_ID })).toBe(true);
    expect(accepted(deleteProductSchema, { productId: "" })).toBe(false);
    expect(accepted(deleteProductSchema, { productId: "x".repeat(65) })).toBe(false);
    expect(accepted(deleteProductSchema, {})).toBe(false);
  });
});

const VALID_CREATE_INPUT: ProductFormValues = {
  name: "  Wireless Mouse  ",
  description: "A reliable wireless mouse for daily use.",
  price: "1234.5",
  stock: "12",
  shippingTime: "1-5 business days",
  categoryId: VALID_PRODUCT_ID,
  shortDescription: "  Compact wireless mouse  ",
  tag: "  mouse  ",
  thumbnail: "https://images.unsplash.com/photo-123",
};

describe("createProductSchema", () => {
  it("keeps the client form schema for string inputs", () => {
    expect(accepted(productFormSchema, VALID_CREATE_INPUT)).toBe(true);
  });

  it("coerces, trims and strips the server payload", () => {
    const parsed = createProductSchema.parse({
      ...VALID_CREATE_INPUT,
      isAvailable: true,
    });

    expect(parsed).toMatchObject({
      name: "Wireless Mouse",
      description: "A reliable wireless mouse for daily use.",
      price: 1234.5,
      stock: 12,
      shippingTime: "1-5 business days",
      categoryId: VALID_PRODUCT_ID,
      shortDescription: "Compact wireless mouse",
      tag: "mouse",
      thumbnail: "https://images.unsplash.com/photo-123",
    });
    expect(parsed).not.toHaveProperty("isAvailable");
  });

  it("treats blank optional fields as absent", () => {
    const parsed = createProductSchema.parse({
      ...VALID_CREATE_INPUT,
      shortDescription: "   ",
      tag: "",
      thumbnail: "",
    });
    expect(parsed.shortDescription).toBeUndefined();
    expect(parsed.tag).toBeUndefined();
    expect(parsed.thumbnail).toBeUndefined();
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-1", -1],
    ["1e12", 1e12],
    ["0.001", 0.001],
    ["10.123", 10.123],
    ["scientific string", "1e3"],
    ["empty", ""],
  ])("rejects fuzz price %s", (_label, price) => {
    expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, price })).toBe(false);
  });

  it("bounds stock to a whole number in 0..100000", () => {
    for (const stock of [0, "0", 100_000, "100000"]) {
      expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, stock }), String(stock)).toBe(true);
    }
    for (const stock of [-1, 1.5, "1.5", 100_001, "100001", "abc", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, stock }), String(stock)).toBe(false);
    }
  });

  it("bounds name (2-120), description (10-5000) and shipping time (1-80)", () => {
    const cases: Array<[string, unknown]> = [
      ["name", "a"],
      ["name", "a".repeat(121)],
      ["description", "a".repeat(9)],
      ["description", "a".repeat(5001)],
      ["shippingTime", ""],
      ["shippingTime", "a".repeat(81)],
    ];
    for (const [field, value] of cases) {
      expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, [field]: value }), field).toBe(false);
    }
    expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, name: "ab", description: "a".repeat(10), shippingTime: "a".repeat(80) })).toBe(true);
  });

  it("bounds optional short description (10-300) and tag (40)", () => {
    expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, shortDescription: "a".repeat(9) })).toBe(false);
    expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, shortDescription: "a".repeat(10) })).toBe(true);
    expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, shortDescription: "a".repeat(300) })).toBe(true);
    expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, shortDescription: "a".repeat(301) })).toBe(false);
    expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, tag: "a".repeat(40) })).toBe(true);
    expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, tag: "a".repeat(41) })).toBe(false);
  });

  it("requires a category id", () => {
    expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, categoryId: "" })).toBe(false);
    expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, categoryId: "x".repeat(65) })).toBe(false);
  });

  it("only accepts thumbnails from the shared image allowlist", () => {
    for (const host of ALLOWED_IMAGE_HOSTS) {
      expect(
        accepted(createProductSchema, { ...VALID_CREATE_INPUT, thumbnail: `https://${host}/photo.jpg` }),
        host
      ).toBe(true);
    }
    for (const thumbnail of [
      "http://images.unsplash.com/photo.jpg",
      "https://evil.example/photo.jpg",
      "javascript:alert(1)",
      `https://images.unsplash.com/${"a".repeat(2048)}`,
    ]) {
      expect(accepted(createProductSchema, { ...VALID_CREATE_INPUT, thumbnail }), thumbnail).toBe(false);
    }
  });
});

const image = (url: string, isMain = false) => ({ url, isMain });
const ALLOWED_URL = "https://images.unsplash.com/photo-1";

describe("image schemas", () => {
  it("accepts 1 to 8 allowlisted images and defaults isMain to false", () => {
    const one = imageFormSchema.parse({ images: [image(ALLOWED_URL)] });
    expect(one.images).toEqual([{ url: ALLOWED_URL, isMain: false }]);

    const eight = Array.from({ length: 8 }, (_, index) => image(`${ALLOWED_URL}-${index}`, index === 0));
    expect(accepted(imageFormSchema, { images: eight })).toBe(true);

    expect(accepted(imageFormSchema, { images: [] })).toBe(false);
    expect(accepted(imageFormSchema, { images: Array.from({ length: 9 }, () => image(ALLOWED_URL)) })).toBe(false);
  });

  it("rejects non-allowlisted hosts, non-https protocols and malformed URLs", () => {
    for (const url of [
      "http://images.unsplash.com/photo-1",
      "https://evil.example/photo-1",
      "https://images.unsplash.com.evil.example/photo-1",
      "not-a-url",
      "",
    ]) {
      expect(accepted(imageFormSchema, { images: [image(url)] }), url).toBe(false);
    }
  });

  it("allows at most one main image per request", () => {
    expect(
      accepted(imageFormSchema, {
        images: [image(ALLOWED_URL, true), image(`${ALLOWED_URL}-2`, true)],
      })
    ).toBe(false);

    const parsed = imageFormSchema.safeParse({
      images: [image(ALLOWED_URL, true), image(`${ALLOWED_URL}-2`, true)],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["images"]);
    }

    expect(accepted(imageFormSchema, { images: [image(ALLOWED_URL, true), image(`${ALLOWED_URL}-2`)] })).toBe(true);
  });

  it("addImagesInputSchema also requires a bounded product id", () => {
    const images = [image(ALLOWED_URL)];
    expect(accepted(addImagesInputSchema, { productId: VALID_PRODUCT_ID, images })).toBe(true);
    expect(accepted(addImagesInputSchema, { productId: "", images })).toBe(false);
    expect(accepted(addImagesInputSchema, { productId: "x".repeat(65), images })).toBe(false);
  });
});
