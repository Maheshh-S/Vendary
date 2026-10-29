import crypto from "crypto"

/**
 * Pure Razorpay signature verification, split out of the server actions so
 * the money-path trust boundary can be unit-tested without Prisma or the
 * Razorpay SDK. Every verifier is fail-closed: a missing secret rejects.
 */

export const verifyRazorpayPaymentSignature = (
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string,
  keySecret: string | undefined
): boolean => {
  // Fail closed: without the secret no signature can be trusted.
  if (!keySecret) {
    return false
  }
  const text = `${razorpayOrderId}|${razorpayPaymentId}`
  const expected = crypto.createHmac("sha256", keySecret).update(text).digest("hex")

  const a = Buffer.from(expected, "hex")
  const b = Buffer.from(razorpaySignature, "hex")
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export const verifyRazorpayWebhookSignature = (
  rawBody: string,
  signature: string | null,
  webhookSecret: string | undefined
): boolean => {
  if (!webhookSecret || !signature) {
    return false
  }
  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex")

  const a = Buffer.from(expected, "hex")
  const b = Buffer.from(signature, "hex")
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Test/debug helper — produces a valid signature for the given secret. */
export const signRazorpayPayload = (text: string, secret: string): string =>
  crypto.createHmac("sha256", secret).update(text).digest("hex")
