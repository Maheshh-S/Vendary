import { z } from "zod";

export const placeOrderSchema = z.object({
    fName: z.string().min(1, "First name is required"),
    lName: z.string().optional(),
    mobile: z.string()
        .min(1, "Phone number is required")
        .transform((val) => {
            const digits = val.replace(/\D/g, "");
            // Allow a leading 91 country code; validate the last 10 digits.
            return digits.length > 10 && digits.startsWith("91") ? digits.slice(2) : digits;
        })
        .pipe(z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number")),
    pinCode: z.string().min(1, "Postal code is required"),
    address: z.string().min(1, "Address is required"),
    area: z.string().min(1, "Area is required"),
    landmark: z.string().min(1, "Landmark is required"),
    country: z.tuple([z.string(), z.string().optional()])
});

export type PlaceOrderSchema = z.infer<typeof placeOrderSchema>;