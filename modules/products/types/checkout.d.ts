/**
 * The client-side checkout session (persisted in localStorage).
 *
 * Only `productId` and `quantity` ever influence money: the server re-derives
 * every amount from the database (see actions/orders). `price_data` is a
 * display snapshot for the summary UI and is stripped at the server boundary;
 * `unit_amount` is integer paise (the same unit as the cart's `unitPaise`).
 */
export type CheckoutLineItem = {
  productId: string;
  quantity: number;
};

/** The only part of a checkout session the charge path accepts. */
export type CheckoutLineItems = {
  line_items: CheckoutLineItem[];
};

export type CheckoutSession = {
  line_items: (CheckoutLineItem & {
    price_data: {
      currency: string;
      product_data: {
        name: string;
        images: string[];
      };
      unit_amount: number;
    };
  })[];
};
