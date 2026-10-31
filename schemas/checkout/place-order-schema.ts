import { z } from "zod";

/**
 * Bounds are finite: every field ends up in a database row or a Razorpay
 * request, so unbounded strings are a cheap way to bloat storage and logs.
 * The address fields mirror the shape of an Indian delivery address (a real
 * 6-digit PIN, a street line, an area, an optional landmark).
 */
export const checkoutLineItemSchema = z.object({
    productId: z.string().min(1).max(64),
    quantity: z.number().int().min(1, "Quantity must be at least 1").max(99, "Quantity cannot exceed 99"),
});

export const checkoutSessionSchema = z.object({
    line_items: z.array(checkoutLineItemSchema).min(1, "Cart is empty").max(100, "Too many items in cart"),
});

export const placeOrderSchema = z.object({
    fName: z.string().min(1, "First name is required").max(60, "First name is too long"),
    lName: z.string().max(60, "Last name is too long").optional(),
    mobile: z.string()
        .min(1, "Phone number is required")
        .transform((val) => {
            const digits = val.replace(/\D/g, "");
            // Allow a leading 91 country code; validate the last 10 digits.
            return digits.length > 10 && digits.startsWith("91") ? digits.slice(2) : digits;
        })
        .pipe(z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number")),
    pinCode: z.string().regex(/^\d{6}$/, "Enter a valid 6-digit PIN code"),
    address: z.string().min(5, "Address is too short").max(200, "Address is too long"),
    area: z.string().min(2, "Area is too short").max(100, "Area is too long"),
    landmark: z.string().min(1, "Landmark is required").max(120, "Landmark is too long"),
    country: z.tuple([
        z.string().max(100, "Country is too long"),
        z.string().max(100, "State is too long").optional(),
    ]),
});

export type PlaceOrderSchema = z.infer<typeof placeOrderSchema>;
