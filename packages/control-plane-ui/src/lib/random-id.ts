type BrowserCrypto = Partial<Pick<Crypto, "getRandomValues" | "randomUUID">>;

let fallbackSequence = 0;

/**
 * Generates a UUID in both secure and non-secure browser contexts.
 *
 * `crypto.randomUUID()` is restricted to secure contexts in browsers, while
 * `crypto.getRandomValues()` remains available on legacy HTTP deployments.
 * The final fallback is only an idempotency/correlation identifier; it is not
 * suitable for credentials or other security-sensitive values.
 */
export function createBrowserUuid(source: BrowserCrypto | null | undefined = globalThis.crypto) {
  if (typeof source?.randomUUID === "function") return source.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function") {
    source.getRandomValues(bytes);
  } else {
    fallbackSequence = (fallbackSequence + 1) >>> 0;
    const timestamp = Date.now();
    for (let index = 0; index < bytes.length; index += 1) {
      const timeByte = Math.floor(timestamp / (2 ** ((index % 6) * 8))) & 0xff;
      const sequenceByte = (fallbackSequence >>> ((index % 4) * 8)) & 0xff;
      bytes[index] = Math.floor(Math.random() * 256) ^ timeByte ^ sequenceByte;
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
