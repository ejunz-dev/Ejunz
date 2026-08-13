export interface LocaleInfo {
  name: string;
  flag?: string;
}

export type TranslationParam = string | number;

interface I18nWindow extends Window {
  EjunzLocale?: Record<string, string>;
  EjunzLocaleList?: Record<string, LocaleInfo>;
}

const i18nWindow = (): I18nWindow => (typeof window === 'undefined' ? {} as I18nWindow : window);

function substitute(value: string, params: TranslationParam[]): string {
  return value.replace(/\{(\d+)\}/g, (match, index: string) => (
    index in params ? String(params[Number(index)]) : match
  ));
}

export function i18n(key: string, ...params: TranslationParam[]): string {
  const translated = i18nWindow().EjunzLocale?.[key] || key;
  return substitute(translated, params);
}

export function getLocaleList(): Record<string, LocaleInfo> {
  return i18nWindow().EjunzLocaleList || {};
}
