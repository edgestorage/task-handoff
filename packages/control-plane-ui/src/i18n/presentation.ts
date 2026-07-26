import type { SupportedLocale } from "./locale.ts";

const naturalCollators = new Map<SupportedLocale, Intl.Collator>();

export function formatDate(value: Date | number | string, locale: SupportedLocale) {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

export function formatTime(value: Date | number | string, locale: SupportedLocale) {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

export function formatDateTime(value: Date | number | string, locale: SupportedLocale) {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatNumber(value: number, locale: SupportedLocale, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, ...options }).format(value);
}

export function formatPercent(value: number, locale: SupportedLocale) {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: value >= 0.1 ? 0 : 1,
  }).format(value);
}

export function formatBytes(value: number, locale: SupportedLocale) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = Math.max(0, value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: amount >= 10 || unit === 0 ? 0 : 1,
  }).format(amount)} ${units[unit]}`;
}

export function formatRelativeTime(value: Date | number | string, now: Date | number, locale: SupportedLocale) {
  const deltaSeconds = (new Date(value).getTime() - new Date(now).getTime()) / 1000;
  const absolute = Math.abs(deltaSeconds);
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] = absolute < 60
    ? [deltaSeconds, "second"]
    : absolute < 3600
      ? [deltaSeconds / 60, "minute"]
      : absolute < 86400
        ? [deltaSeconds / 3600, "hour"]
        : [deltaSeconds / 86400, "day"];
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(Math.round(amount), unit);
}

export function naturalTextCollator(locale: SupportedLocale) {
  let collator = naturalCollators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    naturalCollators.set(locale, collator);
  }
  return collator;
}

export function compareNaturalText(left: string, right: string, locale: SupportedLocale) {
  return naturalTextCollator(locale).compare(left, right);
}

export function compareTechnicalIdentifiers(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
