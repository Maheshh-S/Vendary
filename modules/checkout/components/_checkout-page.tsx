import { useState, useEffect } from 'react';
import CheckoutForm from './_checkout-form';
import ItemsSummary from './_items-summary';
import QuoteBanner from './_quote-banner';
import { PermissionState } from '@/hooks/use-geolocation';
import { useCartQuote } from '@/hooks/use-cart-quote';
import { CheckoutSession } from '@/modules/products/types/checkout';
import { hasBlockingQuoteIssue } from '@/schemas/cart/quote-schema';
import toast from 'react-hot-toast';

const useGeolocation = () => {
  const [permissionState, setPermissionState] = useState<PermissionState>(PermissionState.UNKNOWN);

  useEffect(() => {
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(permissionStatus => {
        setPermissionState(permissionStatus.state as PermissionState);
        permissionStatus.onchange = () => {
          setPermissionState(permissionStatus.state as PermissionState);
        };
      });
    }
  }, []);

  const requestLocationPermission = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        () => setPermissionState(PermissionState.GRANTED),
        () => setPermissionState(PermissionState.DENIED)
      );
    }
  };

  return { permissionState, requestLocationPermission };
};

type Props = {
  checkoutSession: CheckoutSession
}

const CheckoutPageComponent = ({ checkoutSession }: Props) => {
  const { permissionState, requestLocationPermission } = useGeolocation();
  const [bannerVisible, setBannerVisible] = useState(true);
  const showBanner = bannerVisible && permissionState !== PermissionState.GRANTED;

  // The quote is the pre-payment truth check: drift and unavailable items are
  // visible here before Razorpay ever opens, and the server re-prices again.
  const lineItems = checkoutSession?.line_items ?? [];
  const quoteQuery = useCartQuote(
    lineItems.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    }))
  );
  const blockingIssue = hasBlockingQuoteIssue(quoteQuery.quote);

  useEffect(() => {
    if (!showBanner) return;

    switch (permissionState) {
      case PermissionState.PROMPT:
      case PermissionState.UNKNOWN:
        toast("Location access is required to autofill your address details.");
        break;
      case PermissionState.DENIED:
        toast("Location access denied. Please enable it in your browser settings.");
        break;
    }
  }, [permissionState, showBanner]);

  const handleDismissBanner = () => {
    setBannerVisible(false);
  };

  return (
    <div className="min-h-screen bg-transparent w-full">
      <div className="container mx-auto px-4 sm:px-6 pt-6 pb-12 max-w-6xl">
        <QuoteBanner
          quote={quoteQuery.quote}
          localLines={lineItems.map((item) => ({
            productId: item.productId,
            unitPaise: Math.round(item.price_data.unit_amount),
          }))}
          errorMessage={quoteQuery.errorMessage}
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="w-full">
            <CheckoutForm checkoutSession={checkoutSession} blocked={blockingIssue} />
          </div>
          <div className="w-full">
            <ItemsSummary checkoutSession={checkoutSession} quote={quoteQuery.quote} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default CheckoutPageComponent;