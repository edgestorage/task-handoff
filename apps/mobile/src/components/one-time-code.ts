export function normalizeOneTimeCode(value: string, length = 6) {
  return value.replace(/\D/g, '').slice(0, length);
}
