import { formatINR } from "@/lib/format-inr";
import { escapeHtml } from "@/lib/html";
import { PROJECT_NAME } from "@/metadata";

import type { OrderEmailView } from "./types";

const money = (paise: number): string => formatINR(paise / 100);

type LayoutOptions = {
  heading: string;
  intro: string;
  note?: string;
  view: OrderEmailView;
};

/**
 * Shared, dependency-free HTML shell for every order email. All interpolated
 * values are escaped; totals are formatted from integer paise so the email
 * always matches what was charged.
 */
export const orderEmailLayout = ({ heading, intro, note, view }: LayoutOptions): string => {
  const itemRows = view.items
    .map(
      (item) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e4e4e7;">${escapeHtml(item.name)}</td>
          <td style="padding:8px 0;border-bottom:1px solid #e4e4e7;text-align:center;">${item.quantity}</td>
          <td style="padding:8px 0;border-bottom:1px solid #e4e4e7;text-align:right;">${escapeHtml(money(item.unitPaise))}</td>
          <td style="padding:8px 0;border-bottom:1px solid #e4e4e7;text-align:right;">${escapeHtml(money(item.unitPaise * item.quantity))}</td>
        </tr>`
    )
    .join("");

  const addressLines = view.address
    ? [
        view.address.name,
        view.address.address,
        [view.address.area, view.address.landmark].filter(Boolean).join(", "),
        [view.address.state, view.address.postalCode].filter(Boolean).join(" "),
        view.address.country,
        view.address.phone,
      ]
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `${escapeHtml(line)}<br />`)
        .join("")
    : "No delivery address on file.";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(heading)} — ${escapeHtml(PROJECT_NAME)}</title>
  </head>
  <body style="margin:0;padding:0;background:#fafafa;color:#18181b;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
      <p style="margin:0 0 24px;font-size:20px;font-weight:700;">${escapeHtml(PROJECT_NAME)}</p>
      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:24px;">
        <h1 style="margin:0 0 8px;font-size:20px;">${escapeHtml(heading)}</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">${escapeHtml(intro)}</p>

        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
          <tr>
            <td style="padding:4px 0;color:#71717a;">Order</td>
            <td style="padding:4px 0;text-align:right;">#${escapeHtml(view.orderId)}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#71717a;">Status</td>
            <td style="padding:4px 0;text-align:right;text-transform:capitalize;">${escapeHtml(view.status)}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#71717a;">Placed</td>
            <td style="padding:4px 0;text-align:right;">${escapeHtml(view.placedAt)}</td>
          </tr>
        </table>

        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <thead>
            <tr>
              <th style="padding:0 0 8px;text-align:left;color:#71717a;font-weight:600;">Item</th>
              <th style="padding:0 0 8px;text-align:center;color:#71717a;font-weight:600;">Qty</th>
              <th style="padding:0 0 8px;text-align:right;color:#71717a;font-weight:600;">Price</th>
              <th style="padding:0 0 8px;text-align:right;color:#71717a;font-weight:600;">Line total</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows}
          </tbody>
        </table>

        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:16px;">
          <tr>
            <td style="padding:4px 0;color:#71717a;">Subtotal</td>
            <td style="padding:4px 0;text-align:right;">${escapeHtml(money(view.subtotalPaise))}</td>
          </tr>
          ${
            view.discountPaise > 0
              ? `<tr>
            <td style="padding:4px 0;color:#71717a;">Discount${view.couponCode ? ` (${escapeHtml(view.couponCode)})` : ""}</td>
            <td style="padding:4px 0;text-align:right;">−${escapeHtml(money(view.discountPaise))}</td>
          </tr>`
              : ""
          }
          <tr>
            <td style="padding:4px 0;color:#71717a;">Tax (GST)</td>
            <td style="padding:4px 0;text-align:right;">${escapeHtml(money(view.taxPaise))}</td>
          </tr>
          <tr>
            <td style="padding:8px 0 0;border-top:1px solid #e4e4e7;font-weight:700;">Total</td>
            <td style="padding:8px 0 0;border-top:1px solid #e4e4e7;text-align:right;font-weight:700;">${escapeHtml(money(view.totalPaise))}</td>
          </tr>
        </table>

        <h2 style="margin:24px 0 8px;font-size:15px;">Delivery address</h2>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#3f3f46;">${addressLines}</p>

        ${
          note
            ? `<p style="margin:24px 0 0;font-size:14px;line-height:1.5;color:#3f3f46;">${escapeHtml(note)}</p>`
            : ""
        }
      </div>
      <p style="margin:20px 0 0;font-size:12px;color:#71717a;text-align:center;">
        You are receiving this email because you placed an order with ${escapeHtml(PROJECT_NAME)}.
      </p>
    </div>
  </body>
</html>`;
};
