"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_STORAGE_KEY,
  type CountryCode,
  type CurrencyCode,
  type Locale,
  type LocaleOption,
  refreshFxRates,
} from "@/lib/locales";

interface LocaleContextValue {
  countryCode: CountryCode;
  currency: CurrencyCode;
  phonePrefix: string;
  locale: Locale;
  locales: LocaleOption[];
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({
  ...DEFAULT_LOCALE,
  locale: DEFAULT_LOCALE,
  locales: LOCALES,
  setLocale: () => {},
});

function loadStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!raw) return DEFAULT_LOCALE;
    const parsed = JSON.parse(raw) as Partial<Locale>;
    const match = LOCALES.find(
      (l) => l.countryCode === parsed.countryCode && l.currency === parsed.currency,
    );
    if (match) {
      return { countryCode: match.countryCode, currency: match.currency, phonePrefix: match.phonePrefix };
    }
  } catch {
    // Corrupt storage: fall through to default.
  }
  return DEFAULT_LOCALE;
}

export default function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    setLocaleState(loadStoredLocale());
    void refreshFxRates();
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable (private mode): context still updates for the session.
    }
  }, []);

  return (
    <LocaleContext.Provider
      value={{
        countryCode: locale.countryCode,
        currency: locale.currency,
        phonePrefix: locale.phonePrefix,
        locale,
        locales: LOCALES,
        setLocale,
      }}
    >
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
