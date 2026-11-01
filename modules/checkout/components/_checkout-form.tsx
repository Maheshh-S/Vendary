"use client";

import { useState, useEffect } from "react";
import { toast } from "react-hot-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import LocationSelector from "@/components/ui/location-selector";
import { placeOrderSchema, PlaceOrderSchema } from "@/schemas/checkout/place-order-schema";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import useCart from "@/hooks/use-cart";
import type { CheckoutLineItems, CheckoutSession } from "@/modules/products/types/checkout";
import { PlaceOrder, createRazorpayOrder } from "@/actions/orders";
import { useLocale } from "@/providers/locale-provider";
import type { Country } from "react-phone-number-input";
import SavedAddressSelector from "./saved-address-selector";
import type { SavedAddressView } from "@/modules/account/types";

type RazorpaySuccessResponse = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};

// Add Razorpay types
declare global {
  interface Window {
    Razorpay: any;
  }
}

export default function CheckoutForm({
  checkoutSession,
  blocked = false,
  blockedMessage,
}: {
  checkoutSession: CheckoutSession;
  /** True while the server quote is loading, errored, or reports an issue. */
  blocked?: boolean;
  /** Optional explanation rendered under the disabled payment button. */
  blockedMessage?: string;
}) {
  const [, setCountryName] = useState<string>('');
  const [stateName, setStateName] = useState<string>('');
  const [savedLocation, setSavedLocation] = useState<{ country: string; state: string } | null>(
    null
  );
  const [isRazorpayLoaded, setIsRazorpayLoaded] = useState(false);
  const { clearCart } = useCart();
  const { countryCode } = useLocale();
  const router = useRouter();

  // Load Razorpay script
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => setIsRazorpayLoaded(true);
    document.body.appendChild(script);
    
    return () => {
      document.body.removeChild(script);
    };
  }, []);

  const form = useForm<PlaceOrderSchema>({
    resolver: zodResolver(placeOrderSchema),
    defaultValues: {
      fName: "",
      lName: "",
      mobile: "",
      pinCode: "",
      address: "",
      area: "",
      landmark: "",
      country: ["", ""]
    }
  });

  const {
    mutate: OrderNow,
    isPending
  } = useMutation({
    mutationKey: ["place-order"],
    mutationFn: PlaceOrder,
    onMutate: () => {
      toast.loading("Placing your order", { id: "place-order" });
    },
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.message, { id: "place-order" });
        return;
      }
      clearCart();
      toast.success("Order placed successfully", { id: "place-order" });
      router.push('/my-orders');
    },
    onError: (error) => {
      toast.error("Failed to place order", { id: "place-order" });
      console.error("Error placing order", error);
    }
  });

  /**
   * Maps the server's `fieldErrors` onto the form so "First name is required"
   * etc. appear under the offending input; returns the first message for the
   * toast when the summary copy is too generic.
   */
  const applyServerFieldErrors = (
    fieldErrors?: Record<string, string[]>
  ): string | undefined => {
    if (!fieldErrors) return undefined;

    let firstMessage: string | undefined;
    for (const [field, messages] of Object.entries(fieldErrors)) {
      const message = messages[0];
      if (!message) continue;
      firstMessage ??= message;
      if (field in placeOrderSchema.shape) {
        form.setError(field as keyof PlaceOrderSchema, { type: "server", message });
      }
    }
    return firstMessage;
  };

  // Initialize and open Razorpay payment
  const initializeRazorpayPayment = async (orderData: PlaceOrderSchema) => {
    if (!isRazorpayLoaded) {
      toast.error("Payment gateway is loading. Please try again.");
      return;
    }

    try {
      toast.loading("Initializing payment...", { id: "razorpay-init" });

      // Create the Razorpay order and the durable pending order on the server.
      // Prices are deliberately dropped: the charge path re-prices from the DB.
      const chargeSession: CheckoutLineItems = {
        line_items: (checkoutSession.line_items ?? []).map(({ productId, quantity }) => ({
          productId,
          quantity,
        })),
      };
      const init = await createRazorpayOrder({
        checkoutSession: chargeSession,
        orderData
      });

      if (!init.ok) {
        const fieldMessage = applyServerFieldErrors(init.fieldErrors);
        toast.error(fieldMessage ?? init.message, { id: "razorpay-init" });
        return;
      }

      const { razorpayOrderId, amountPaise, currency } = init.data;

      toast.success("Payment initialized", { id: "razorpay-init" });

      // Configure Razorpay options
      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: amountPaise,
        currency,
        name: "Vendary",
        description: "Order Payment",
        order_id: razorpayOrderId,
        prefill: {
          name: `${orderData.fName} ${orderData.lName || ''}`,
          email: '', // You may want to add email to your form
          contact: orderData.mobile
        },
        notes: {
          address: orderData.address
        },
        theme: {
          color: "#3B82F6" // Blue color to match your button
        },
        handler: function(response: RazorpaySuccessResponse) {
          if (response.razorpay_order_id !== razorpayOrderId) {
            toast.error("Payment does not match this order. Please contact support.", { id: "place-order" });
            return;
          }
          // The server re-derives everything from the order created above.
          OrderNow({
            razorpayOrderId: response.razorpay_order_id,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpaySignature: response.razorpay_signature
          });
        }
      };

      // Initialize Razorpay
      const razorpay = new window.Razorpay(options);
      razorpay.open();
      
    } catch (error) {
      toast.error("Payment initialization failed", { id: "razorpay-init" });
      console.error("Razorpay initialization failed:", error);
    }
  };

  /**
   * Fills the checkout fields from a saved address. The submitted shape is
   * still `PlaceOrderSchema` — nothing about the saved row reaches the order
   * except as form values, which the server snapshots into a new `Address`.
   */
  const applySavedAddress = (address: SavedAddressView) => {
    form.setValue("fName", address.firstName);
    form.setValue("lName", address.lastName);
    // The catalog stores the bare 10-digit number; PhoneInput expects E.164.
    form.setValue("mobile", address.phone ? `+91${address.phone}` : "");
    form.setValue("address", address.line1);
    form.setValue("area", address.area);
    form.setValue("pinCode", address.postalCode);
    form.setValue("landmark", address.landmark ?? "");
    form.setValue("country", [address.country, address.state]);
    setStateName(address.state);
    setSavedLocation({ country: address.country, state: address.state });
  };

  function onSubmit(values: PlaceOrderSchema) {
    if (blocked) {
      toast.error(
        blockedMessage ?? "Please fix the items in your cart before paying.",
        { id: "checkout-blocked" }
      );
      return;
    }
    // Instead of directly placing order, initialize Razorpay payment
    initializeRazorpayPayment(values);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 py-6">
        <h2 className="text-2xl font-medium mb-6">Shipping Information</h2>

        <SavedAddressSelector onSelect={applySavedAddress} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="fName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>First name</FormLabel>
                <FormControl>
                  <Input 
                    placeholder="John"
                    className="bg-transparent"
                    {...field} 
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          
          <FormField
            control={form.control}
            name="lName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Last name</FormLabel>
                <FormControl>
                  <Input 
                    placeholder="Doe"
                    className="bg-transparent"
                    {...field} 
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        
        <FormField
          control={form.control}
          name="mobile"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Phone number</FormLabel>
              <FormControl>
                <PhoneInput
                  placeholder="Enter your phone number"
                  className="bg-transparent"
                  {...field}
                  defaultCountry={countryCode as Country}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      
        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Address</FormLabel>
              <FormControl>
                <Input 
                  placeholder="123 Main Street, Apt 4B"
                  className="bg-transparent"
                  {...field} 
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="area"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Area/Neighborhood</FormLabel>
                <FormControl>
                  <Input 
                    placeholder="Downtown"
                    className="bg-transparent"
                    {...field} 
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          
          <FormField
            control={form.control}
            name="pinCode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Postal Code</FormLabel>
                <FormControl>
                  <Input 
                    placeholder="560001"
                    className="bg-transparent"
                    {...field} 
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        
        <FormField
          control={form.control}
          name="landmark"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Landmark</FormLabel>
              <FormControl>
                <Input 
                  placeholder="Near Central Park"
                  className="bg-transparent"
                  {...field} 
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        
        <FormField
          control={form.control}
          name="country"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Location</FormLabel>
              <FormControl>
                <LocationSelector
                  initialCountryName={savedLocation?.country}
                  initialStateName={savedLocation?.state}
                  onCountryChange={(country) => {
                    setCountryName(country?.name || '');
                    form.setValue(field.name, [country?.name || '', stateName || '']);
                  }}
                  onStateChange={(state) => {
                    setStateName(state?.name || '');
                    form.setValue(field.name, [form.getValues(field.name)[0] || '', state?.name || '']);
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        
        <Button 
          type="submit" 
          disabled={isPending || !isRazorpayLoaded || blocked}
          className="w-full mt-8 bg-blue-600 hover:bg-blue-700 transition-colors"
        >
          {isPending ? "Processing..." : "Proceed to Payment"}
        </Button>
        {blocked && (
          <p className="mt-2 text-center text-xs text-red-600 dark:text-red-400">
            {blockedMessage ??
              "Some items in your cart are unavailable. Go back to the cart to fix them."}
          </p>
        )}
      </form>
    </Form>
  );
}