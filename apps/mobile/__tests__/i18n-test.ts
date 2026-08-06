import { translate } from '../src/i18n';
import { matchSupportedLocale, resolveLocale, sanitizeLocalePreference } from '../src/i18n/locale';

describe('mobile i18n', () => {
  test('normalizes supported English and simplified Chinese system locales', () => {
    expect(matchSupportedLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(matchSupportedLocale('zh_CN')).toBe('zh-CN');
    expect(matchSupportedLocale('en-GB')).toBe('en-US');
  });

  test('falls back to English for unsupported system locales', () => {
    expect(resolveLocale('system', ['ja-JP', 'fr-FR'])).toBe('en-US');
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
    expect(sanitizeLocalePreference('de-DE')).toBe('system');
  });

  test('formats translated parameters and English plural forms', () => {
    expect(translate('zh-CN', 'sessions.filterAccessibility', { scope: '全部会话' })).toBe('筛选会话，当前范围：全部会话');
    expect(translate('en-US', 'directories.instanceCount', { count: 1 })).toBe('1 Instance');
    expect(translate('en-US', 'directories.instanceCount', { count: 3 })).toBe('3 Instances');
  });
});
