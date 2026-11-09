import { formatRecoveryCode, normalizeRecoveryCode, normalizeSecondFactorCode } from '../src/components/recovery-code';

test('recovery codes are uppercased, compacted, and grouped consistently', () => {
  expect(normalizeRecoveryCode(' abcd efgh-ijkl mnop ')).toBe('ABCDEFGHIJKLMNOP');
  expect(formatRecoveryCode(' abcd efgh-ijkl mnop ')).toBe('ABCDE-FGHIJ-KLMNO-P');
  expect(formatRecoveryCode('abcde-fghij-klmno-pqrst-uvwxy')).toBe('ABCDE-FGHIJ-KLMNO-PQRST-UVWXY');
});

test('security code normalization keeps six-digit authenticator codes numeric', () => {
  expect(normalizeSecondFactorCode('12 34-56')).toBe('123456');
  expect(normalizeSecondFactorCode('12345678')).toBe('12345-678');
  expect(normalizeSecondFactorCode('abcde fghij-klmno p')).toBe('ABCDE-FGHIJ-KLMNO-P');
});
