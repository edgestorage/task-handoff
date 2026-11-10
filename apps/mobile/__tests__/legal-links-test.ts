import { legalPageUrl } from '../src/legal/links';

describe('mobile legal links', () => {
  test('maps the mobile locale to the public page query', () => {
    expect(legalPageUrl('privacy', 'zh-CN', 'https://cloud.example.com')).toBe('https://cloud.example.com/privacy?lang=zh');
    expect(legalPageUrl('terms', 'en-US', 'https://cloud.example.com')).toBe('https://cloud.example.com/terms?lang=en');
  });

  test('replaces a configured path with the legal route', () => {
    expect(legalPageUrl('privacy', 'en-US', 'https://cloud.example.com/account')).toBe('https://cloud.example.com/privacy?lang=en');
  });
});
