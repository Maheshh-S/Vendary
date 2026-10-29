/**
 * The client-side checkout session (persisted in localStorage). Product ids
 * and quantities only — prices are never sent by the client; the server
 * re-derives every amount from the database (see actions/orders).
 */
export type CheckoutSession = {
    line_items: {
      productId: string;
      price_data: {
        currency: string;
        product_data: {
          name: string;
          images: string[];
        };
        unit_amount: number;
      };
      quantity: number;
    }[];
  };
