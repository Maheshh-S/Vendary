import * as z from "zod";

/** A single user may keep at most this many saved addresses. */
export const MAX_SAVED_ADDRESSES = 10;

/** Blank optional inputs arrive as "" from forms; store them as null/absent. */
const optionalText = (max: number, message: string) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max, message).optional()
  );

/**
 * Saved-address input contract. Phone and postal rules mirror
 * `placeOrderSchema` where the two forms overlap; checkout additionally
 * requires a landmark and takes a single street line (the checkout prefill
 * joins `line1` and `line2`), so a saved address can still need a landmark
 * entered before checkout accepts it.
 */
export const SavedAddressInputSchema = z.object({
  label: optionalText(40, "Label is too long"),
  firstName: z.string().trim().min(1, "First name is required").max(60, "First name is too long"),
  // Optional to match the checkout form, which allows a missing last name.
  lastName: z.string().trim().max(60, "Last name is too long").default(""),
  phone: z
    .string()
    .min(1, "Phone number is required")
    .transform((value) => {
      const digits = value.replace(/\D/g, "");
      // Allow a leading 91 country code; validate the last 10 digits.
      return digits.length > 10 && digits.startsWith("91") ? digits.slice(2) : digits;
    })
    .pipe(z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number")),
  line1: z.string().trim().min(5, "Address is too short").max(200, "Address is too long"),
  line2: optionalText(200, "Address line 2 is too long"),
  area: z.string().trim().min(2, "Area is too short").max(100, "Area is too long"),
  landmark: optionalText(120, "Landmark is too long"),
  state: z.string().trim().min(1, "State is required").max(100, "State is too long"),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter a valid 6-digit PIN code"),
  country: z.string().trim().min(1, "Country is required").max(100, "Country is too long"),
  isDefault: z.boolean().default(false),
});

export const UpdateSavedAddressSchema = SavedAddressInputSchema.extend({
  id: z.string().trim().min(1, "Address id is required").max(64, "Address id is invalid"),
});

export const SavedAddressIdSchema = z
  .string()
  .trim()
  .min(1, "Address id is required")
  .max(64, "Address id is invalid");

export type SavedAddressInput = z.infer<typeof SavedAddressInputSchema>;
export type UpdateSavedAddressInput = z.infer<typeof UpdateSavedAddressSchema>;
