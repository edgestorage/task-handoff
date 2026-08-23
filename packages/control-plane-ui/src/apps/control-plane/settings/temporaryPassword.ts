const TEMPORARY_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_";

export function generateTemporaryPassword(length = 20) {
  if (!Number.isInteger(length) || length < 8 || length > 256) {
    throw new RangeError("Temporary password length must be an integer between 8 and 256.");
  }
  const result: string[] = [];
  const bytes = new Uint8Array(Math.max(32, length));
  const limit = 256 - (256 % TEMPORARY_PASSWORD_ALPHABET.length);
  while (result.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit) result.push(TEMPORARY_PASSWORD_ALPHABET[byte % TEMPORARY_PASSWORD_ALPHABET.length]);
      if (result.length === length) break;
    }
  }
  return result.join("");
}
