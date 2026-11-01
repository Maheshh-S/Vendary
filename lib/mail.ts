import "server-only";

import type { Prisma } from "@prisma/client";
import { Resend } from "resend";

import { prisma } from "@/lib/db/prisma";
import { ORDER_EMAIL_EVENT_TYPE } from "@/lib/orders/events";
import { escapeHtml } from "@/lib/html";
import { BASE_URL, PROJECT_NAME } from "@/metadata";
import { orderConfirmationEmail } from "@/templates/mail/order-confirmation";
import { orderStatusEmail } from "@/templates/mail/order-status";
import { onboardingmail } from "@/templates/mail/onboarding-mail";
import type { OrderEmailKind, OrderEmailView } from "@/templates/mail/types";

/**
 * Mail transport. The Resend client is created lazily because
 * `new Resend(undefined)` throws in environments without a key (unit tests,
 * builds with placeholder env); callers skip when it returns null.
 */
const getResendClient = (): Resend | null => {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  return apiKey ? new Resend(apiKey) : null;
};

/**
 * Sender address. `EMAIL_FROM` is required in production; in local development
 * Resend's shared test sender is used so the flow is exercisable without a
 * verified domain. E2E runs `next start` (NODE_ENV=production) without
 * `EMAIL_FROM`, so sends are skipped there by design.
 */
const DEVELOPMENT_SENDER = "onboarding@resend.dev";

type MailConfig = { from: string; resend: Resend };

export const getOrderMailConfig = (): MailConfig | null => {
  const configuredFrom = process.env.EMAIL_FROM?.trim();
  const from =
    configuredFrom || (process.env.NODE_ENV === "development" ? DEVELOPMENT_SENDER : "");
  const resend = getResendClient();
  return from && resend ? { from, resend } : null;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const sendVerificationEmail = async (email: string, token: string): Promise<void> => {
  const resend = getResendClient();
  if (!resend) return;

  const confirmLink = `${process.env.BASE_URL || BASE_URL}/new-verification?token=${token}`;

  await resend.emails.send({
    from: "Acme <onboarding@resend.dev>",
    to: [email],
    subject: `Confirm Your Email for ${PROJECT_NAME}`,
    html: onboardingmail(confirmLink),
  });
};

/** Outcome of a reset send; the caller keeps its response constant either way. */
export type PasswordResetEmailResult =
  | { status: "sent" }
  | { status: "skipped"; reason: "not_configured" | "rejected" };

/**
 * Sends the password reset link. Never throws: an unconfigured mailbox or a
 * Resend outage must not change the (enumeration-safe) response the requester
 * sees. Log lines contain event codes only — never the address or the token.
 */
export const sendPasswordResetEmail = async (
  email: string,
  token: string
): Promise<PasswordResetEmailResult> => {
  try {
    const resend = getResendClient();
    const from =
      process.env.EMAIL_FROM?.trim() ||
      (process.env.NODE_ENV === "development" ? DEVELOPMENT_SENDER : "");
    if (!resend || !from) {
      console.info(
        JSON.stringify({ level: "info", event: "password_reset_email_skipped", reason: "not_configured" })
      );
      return { status: "skipped", reason: "not_configured" };
    }

    // Prefer the public site URL so the link works behind a proxy; BASE_URL
    // already falls back to NEXT_PUBLIC_SITE_URL.
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || BASE_URL;
    const resetLink = `${siteUrl}/password/reset?token=${encodeURIComponent(token)}`;

    const { error } = await resend.emails.send({
      from,
      to: [email],
      subject: `Reset Password for ${PROJECT_NAME}`,
      html: `
            <p>We received a request to reset the password for your ${escapeHtml(PROJECT_NAME)} account.</p>
            <p>Choose a new password with the link below. It expires in one hour and can be used once.</p>
            <p><a href="${escapeHtml(resetLink)}">Reset password</a></p>
            <p>If you did not request this, you can safely ignore this email — your password has not changed.</p>
            <p>Best regards,</p>
            <p>The ${escapeHtml(PROJECT_NAME)} Team</p>
        `,
    });
    if (error) {
      console.warn(
        JSON.stringify({ level: "warn", event: "password_reset_email_rejected" })
      );
      return { status: "skipped", reason: "rejected" };
    }
    return { status: "sent" };
  } catch (error) {
    // Only the error class name: provider messages can echo request fields.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "password_reset_email_failed",
        error: error instanceof Error ? error.name : "unknown",
      })
    );
    return { status: "skipped", reason: "rejected" };
  }
};

/** One idempotency marker per (order, email kind). */
export type OrderEmailResult =
  | { status: "sent" }
  | {
      status: "skipped";
      reason: "not_configured" | "already_sent" | "no_recipients" | "order_not_found";
    }
  | { status: "failed"; error: string };

type OrderWithEmailData = Prisma.OrderGetPayload<{
  include: {
    items: true;
    address: true;
    user: { select: { email: true } };
  };
}>;

const emailKindFromMetadata = (metadata: Prisma.JsonValue | null): string | null => {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return null;
  }
  const kind = (metadata as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : null;
};

const toPaise = (rupees: Prisma.Decimal | number | string): number =>
  Math.round(Number(rupees) * 100);

const toView = (order: OrderWithEmailData): OrderEmailView => {
  const items = order.items.map((item) => ({
    name: item.productName,
    quantity: item.quantity,
    unitPaise: toPaise(item.price),
  }));
  const subtotalPaise = items.reduce(
    (total, item) => total + item.unitPaise * item.quantity,
    0
  );

  return {
    orderId: order.id,
    status: order.status,
    placedAt: order.createdAt.toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    }),
    items,
    subtotalPaise,
    taxPaise: toPaise(order.taxAmount),
    totalPaise: toPaise(order.total),
    address: order.address
      ? {
          name: [order.address.firstName, order.address.lastName].filter(Boolean).join(" "),
          address: order.address.address,
          area: order.address.area,
          landmark: order.address.landmark,
          state: order.address.state,
          postalCode: order.address.postalCode,
          country: order.address.country,
          phone: order.address.phone,
        }
      : null,
  };
};

const subjectFor = (kind: OrderEmailKind, orderId: string): string => {
  const shortId = orderId.slice(0, 8);
  switch (kind) {
    case "confirmation":
      return `Order confirmed — #${shortId} | ${PROJECT_NAME}`;
    case "shipped":
      return `Your order has shipped — #${shortId} | ${PROJECT_NAME}`;
    case "delivered":
      return `Your order was delivered — #${shortId} | ${PROJECT_NAME}`;
    case "cancelled":
      return `Your order was cancelled — #${shortId} | ${PROJECT_NAME}`;
    case "refunded":
      return `Your refund was processed — #${shortId} | ${PROJECT_NAME}`;
  }
};

const renderOrderEmail = (kind: OrderEmailKind, view: OrderEmailView): string =>
  kind === "confirmation" ? orderConfirmationEmail(view) : orderStatusEmail(kind, view);

const recipientsFor = (order: OrderWithEmailData): { to: string[]; bcc?: string[] } => {
  const customer = order.user?.email?.trim() || undefined;
  const store = process.env.ORDER_NOTIFICATION_EMAIL?.trim() || undefined;

  // The store inbox is a hidden copy: putting it in `to` would expose the
  // internal address to the customer on a reply-all.
  if (customer) {
    return store && store !== customer
      ? { to: [customer], bcc: [store] }
      : { to: [customer] };
  }
  return store ? { to: [store] } : { to: [] };
};

/**
 * Sends one transactional order email (confirmation or a status change).
 *
 * Idempotency: an `order_email_sent` OrderEvent carrying `{kind}` is written
 * *before* the Resend call and a second call for the same kind is skipped. A
 * send failure therefore leaves the marker behind — orders are never retried
 * automatically, and support can re-send from the dashboard if needed.
 *
 * Never throws: a missing mail config, missing recipients, Resend outage or
 * DB hiccup is logged (or silently skipped) so the order flow always survives.
 * Even building the transport config sits inside the guard, because it runs on
 * the checkout/refund response path where nothing may escape.
 */
export const sendOrderEmail = async (
  orderId: string,
  kind: OrderEmailKind
): Promise<OrderEmailResult> => {
  try {
    const config = getOrderMailConfig();
    if (!config) {
      return { status: "skipped", reason: "not_configured" };
    }

    const existing = await prisma.orderEvent.findMany({
      where: { orderId, type: ORDER_EMAIL_EVENT_TYPE },
      select: { metadata: true },
    });
    if (existing.some((event) => emailKindFromMetadata(event.metadata) === kind)) {
      return { status: "skipped", reason: "already_sent" };
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        address: true,
        user: { select: { email: true } },
      },
    });
    if (!order) {
      return { status: "skipped", reason: "order_not_found" };
    }

    const recipients = recipientsFor(order);
    if (recipients.to.length === 0) {
      return { status: "skipped", reason: "no_recipients" };
    }

    // Written before the send, so a retry of the same transition cannot send a
    // duplicate; the metadata distinguishes the five kinds on one order.
    await prisma.orderEvent.create({
      data: {
        orderId,
        type: ORDER_EMAIL_EVENT_TYPE,
        toStatus: order.status,
        metadata: { kind },
      },
    });

    const { error } = await config.resend.emails.send({
      from: config.from,
      to: recipients.to,
      ...(recipients.bcc ? { bcc: recipients.bcc } : {}),
      subject: subjectFor(kind, order.id),
      html: renderOrderEmail(kind, toView(order)),
    });
    if (error) {
      throw new Error(error.message ?? error.name ?? "Resend rejected the email");
    }

    return { status: "sent" };
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "order_email_failed",
        orderId,
        kind,
        error: errorMessage(error),
      })
    );
    return { status: "failed", error: errorMessage(error) };
  }
};
