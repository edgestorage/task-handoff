import type { SupportedLocale } from '../i18n';
import { mobileCloudEnvironment } from '../platform/build-variant';

export type LegalDocument = 'privacy' | 'terms';

export function legalPageUrl(
  document: LegalDocument,
  locale: SupportedLocale,
  origin = mobileCloudEnvironment.serviceOrigin,
) {
  const url = new URL(`/${document}`, origin);
  url.searchParams.set('lang', locale === 'zh-CN' ? 'zh' : 'en');
  return url.toString();
}
