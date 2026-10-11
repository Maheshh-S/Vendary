import { formatINR } from "@/lib/format-inr";

export type CountryCode = "IN" | "US" | "GB" | "AE" | "SG";
export type CurrencyCode = "INR" | "USD" | "GBP" | "AED" | "SGD";

export interface LocaleOption {
  countryCode: CountryCode;
  currency: CurrencyCode;
  phonePrefix: string;
  name: string;
  flag: string;
  /** Intl locale used when formatting this currency. */
  intlLocale: string;
  /**
   * Display approximation of INR → currency.
   * Static fallback used offline / before the live rate refresh resolves.
   */
  inrToCurrencyRate: number;
}

export interface Locale {
  countryCode: CountryCode;
  currency: CurrencyCode;
  phonePrefix: string;
}

export const LOCALES: LocaleOption[] = [
  { countryCode: "IN", currency: "INR", phonePrefix: "+91", name: "India", flag: "🇮🇳", intlLocale: "en-IN", inrToCurrencyRate: 1 },
  { countryCode: "US", currency: "USD", phonePrefix: "+1", name: "United States", flag: "🇺🇸", intlLocale: "en-US", inrToCurrencyRate: 0.012 },
  { countryCode: "GB", currency: "GBP", phonePrefix: "+44", name: "United Kingdom", flag: "🇬🇧", intlLocale: "en-GB", inrToCurrencyRate: 0.0095 },
  { countryCode: "AE", currency: "AED", phonePrefix: "+971", name: "UAE", flag: "🇦🇪", intlLocale: "en-AE", inrToCurrencyRate: 0.044 },
  { countryCode: "SG", currency: "SGD", phonePrefix: "+65", name: "Singapore", flag: "🇸🇬", intlLocale: "en-SG", inrToCurrencyRate: 0.016 },
];

export const DEFAULT_LOCALE: Locale = {
  countryCode: "IN",
  currency: "INR",
  phonePrefix: "+91",
};

export const LOCALE_STORAGE_KEY = "vendary-locale";

const FX_CACHE_KEY = "vendary-fx-rates";
const FX_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

interface FxCache {
  timestamp: number;
  /** INR → currency rates derived from the USD-based API. */
  rates: Partial<Record<CurrencyCode, number>>;
}

function readFxCache(): FxCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FX_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FxCache;
    if (!parsed || typeof parsed.timestamp !== "number" || !parsed.rates) return null;
    return parsed;
  } catch {
    return null;
  }
}

function staticRate(currency: CurrencyCode): number {
  return LOCALES.find((l) => l.currency === currency)?.inrToCurrencyRate ?? 1;
}

/** Cached live INR→currency rate, falling back to the static display approximation. */
export function getInrRate(currency: CurrencyCode): number {
  if (currency === "INR") return 1;
  const cached = readFxCache();
  if (cached && Date.now() - cached.timestamp < FX_TTL_MS) {
    const live = cached.rates[currency];
    if (typeof live === "number" && live > 0) return live;
  }
  return staticRate(currency);
}

/**
 * Refresh cached rates from exchangerate-api (same endpoint pattern as the
 * currency-converter widget). The public API is USD-based, so INR→X is
 * derived as rates[X] / rates[INR]. Failures keep the static fallback.
 */
export async function refreshFxRates(): Promise<void> {
  if (typeof window === "undefined") return;
  const cached = readFxCache();
  if (cached && Date.now() - cached.timestamp < FX_TTL_MS) return;
  try {
    const res = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    if (!res.ok) return;
    const data = await res.json();
    const inrPerUsd: number = data?.rates?.INR;
    if (!inrPerUsd || inrPerUsd <= 0) return;
    const rates: Partial<Record<CurrencyCode, number>> = {};
    for (const locale of LOCALES) {
      if (locale.currency === "INR") continue;
      const perUsd: number = data?.rates?.[locale.currency];
      if (typeof perUsd === "number" && perUsd > 0) {
        rates[locale.currency] = perUsd / inrPerUsd;
      }
    }
    window.localStorage.setItem(
      FX_CACHE_KEY,
      JSON.stringify({ timestamp: Date.now(), rates } satisfies FxCache),
    );
  } catch {
    // Offline / API failure: callers fall back to the static table.
  }
}

/**
 * Display-only price formatter. Stored numbers are RUPEES.
 * INR renders via formatINR; other currencies convert at the cached live
 * rate (static approximation fallback) and format with the per-currency Intl locale.
 */
export function formatPrice(inrRupees: number | string, locale: Locale): string {
  const rupees = Number(inrRupees);
  if (locale.currency === "INR") return formatINR(rupees);
  const option = LOCALES.find((l) => l.currency === locale.currency);
  const intlLocale = option?.intlLocale ?? "en-US";
  const converted = rupees * getInrRate(locale.currency);
  return new Intl.NumberFormat(intlLocale, {
    style: "currency",
    currency: locale.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(converted);
}
