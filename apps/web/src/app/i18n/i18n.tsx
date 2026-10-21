import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { z } from 'zod';
import { en, fr } from 'zod/locales';
import { type Locale, locales, type MessageKey, messages } from './messages.ts';

// Minimal i18n (FR + EN): a typed dictionary, `{name}` placeholders, and zod's own locale for
// validation messages. The choice is stored per browser.

const STORAGE_KEY = 'ondes.locale';

interface I18n {
  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: MessageKey, params?: Record<string, string | number>): string;
}

const I18nContext = createContext<I18n | null>(null);

function initialLocale(): Locale {
  const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (stored && (locales as readonly string[]).includes(stored)) return stored as Locale;
  return globalThis.navigator?.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

function applyLocale(locale: Locale) {
  z.config(locale === 'fr' ? fr() : en());
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

export function translate(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template = messages[locale][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

export function I18nProvider({
  children,
  locale: forced,
}: {
  children: ReactNode;
  /** Tests pin a locale. */
  locale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const value = forced ?? initialLocale();
    applyLocale(value);
    return value;
  });
  const setLocale = useCallback((next: Locale) => {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
    applyLocale(next);
    setLocaleState(next);
  }, []);
  const value = useMemo<I18n>(
    () => ({ locale, setLocale, t: (key, params) => translate(locale, key, params) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const i18n = useContext(I18nContext);
  if (!i18n) throw new Error('useI18n needs an <I18nProvider>');
  return i18n;
}
