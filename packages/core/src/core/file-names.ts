import path from "node:path";

export const SAFE_FILE_NAME_MAX_LENGTH = 240;
export const SAFE_FILE_SYSTEM_COMPONENT_MAX_BYTES = 255;

export type SafeFileNameOptions = {
  maxBytes?: number;
  maxLength?: number;
};

export function safeFileName(name: string, fallback = "attachment", options: SafeFileNameOptions = {}) {
  const maxLength = options.maxLength ?? SAFE_FILE_NAME_MAX_LENGTH;
  const maxBytes = options.maxBytes ?? SAFE_FILE_NAME_MAX_LENGTH;
  const baseName = path.posix.basename(String(name).replace(/\\/g, "/"));
  const cleaned = baseName
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  const portable = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
  const value = truncateUtf8(portable, maxLength, maxBytes).replace(/[. ]+$/g, "");
  if (value && value !== "." && value !== "..") return value;
  return truncateUtf8(fallback, maxLength, maxBytes) || "attachment";
}

function truncateUtf8(value: string, maxLength: number, maxBytes: number) {
  if (!Number.isInteger(maxLength) || maxLength <= 0 || !Number.isInteger(maxBytes) || maxBytes <= 0) return "";
  let result = "";
  let length = 0;
  let bytes = 0;
  for (const character of value) {
    const nextLength = length + character.length;
    const nextBytes = bytes + Buffer.byteLength(character);
    if (nextLength > maxLength || nextBytes > maxBytes) break;
    result += character;
    length = nextLength;
    bytes = nextBytes;
  }
  return result;
}
