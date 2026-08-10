import { z } from "zod";

export const IdSchema = z.string().trim().min(3).max(160).regex(/^[a-z][a-z0-9_-]*$/);
export const DateTimeSchema = z.string().datetime();
export const Sha256DigestSchema = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);
export const OpaqueSecretSchema = z.string().min(32).max(4096);
export const LocaleTextSchema = z.strictObject({
  default: z.string().trim().min(1).max(160),
  translations: z.record(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/), z.string().trim().min(1).max(160)).default({}),
});

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
