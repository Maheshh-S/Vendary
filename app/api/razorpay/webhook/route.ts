import { prisma } from "@/lib/db/prisma";
import { verifyRazorpayWebhookSignature } from "@/lib/razorpay";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

/**
 * Razorpay webhook backstop. The client success callback (PlaceOrder) is the
 * primary status driver — it creates the order as `confirmed` — so this
 * handler only upgrades orders it finds; a webhook that arrives before the
 * order row exists is a 200 no-op and the row is created confirmed anyway.
 *
 * All transitions use `updateMany` with status guards, which makes replays
 * idempotent. See docs/superpowers/specs/2026-10-29-money-trust-fixes.md.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractEvent = (body: any) => {
  const event = body?.event as string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payment = body?.payload?.payment?.entity as any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refund = body?.payload?.refund?.entity as any | undefined;
  return { event, payment, refund };
};

export async function POST(req: Request) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json(
      { error: "Webhook is not configured (RAZORPAY_WEBHOOK_SECRET missing)" },
      { status: 501 }
    );
  }

  const rawBody = await req.text();
  if (!verifyRazorpayWebhookSignature(rawBody, req.headers.get("x-razorpay-signature"), webhookSecret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { event, payment, refund } = extractEvent(body);

  try {
    if (event === "payment.captured" && payment?.order_id) {
      // pending → confirmed; a captured payment confirms a pending order.
      await prisma.order.updateMany({
        where: { transactionId: payment.order_id, status: "pending" },
        data: { status: "confirmed" },
      });
      revalidatePath("/admin");
      revalidatePath("/my-orders");
    } else if (event === "refund.processed" && refund?.payment_id) {
      // any non-cancelled → cancelled once the refund is processed.
      await prisma.order.updateMany({
        where: { paymentId: refund.payment_id, status: { not: "cancelled" } },
        data: { status: "cancelled" },
      });
      revalidatePath("/admin");
      revalidatePath("/my-orders");
    }
    // Unhandled events are acknowledged so Razorpay stops retrying them.
  } catch (error) {
    // Non-2xx makes Razorpay retry with backoff — right answer for DB outages.
    console.error("Webhook processing failed:", error);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
