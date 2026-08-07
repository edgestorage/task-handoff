import { formatInboxUpdatedTime } from '../src/ai-sessions/Inbox';

function localDate(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(year, month - 1, day, hour, minute);
}

describe('AI Session inbox time', () => {
  const now = localDate(2026, 8, 8, 0, 30);

  test('shows only the time for today', () => {
    expect(formatInboxUpdatedTime(localDate(2026, 8, 8, 0, 13).toISOString(), 'zh-CN', '昨天', now)).toBe('00:13');
  });

  test('adds a localized yesterday label', () => {
    expect(formatInboxUpdatedTime(localDate(2026, 8, 7, 23, 48).toISOString(), 'zh-CN', '昨天', now)).toBe('昨天 23:48');
  });

  test('does not depend on Intl.RelativeTimeFormat', () => {
    const original = Intl.RelativeTimeFormat;
    Object.defineProperty(Intl, 'RelativeTimeFormat', { configurable: true, value: undefined });
    try {
      expect(formatInboxUpdatedTime(localDate(2026, 8, 7, 23, 48).toISOString(), 'zh-CN', '昨天', now)).toBe('昨天 23:48');
      expect(formatInboxUpdatedTime(localDate(2026, 8, 7, 23, 48).toISOString(), 'en-US', 'Yesterday', now)).toBe('Yesterday 11:48 PM');
    } finally {
      Object.defineProperty(Intl, 'RelativeTimeFormat', { configurable: true, value: original });
    }
  });

  test('adds the date for older timestamps and the year only when needed', () => {
    expect(formatInboxUpdatedTime(localDate(2026, 8, 6, 18, 20).toISOString(), 'zh-CN', '昨天', now)).toBe('8月6日 18:20');
    expect(formatInboxUpdatedTime(localDate(2025, 12, 31, 18, 20).toISOString(), 'zh-CN', '昨天', now)).toBe('2025年12月31日 18:20');
  });

  test('does not render an invalid date label', () => {
    expect(formatInboxUpdatedTime('not-a-date', 'zh-CN', '昨天', now)).toBe('');
  });
});
