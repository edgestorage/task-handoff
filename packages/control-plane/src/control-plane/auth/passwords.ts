import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);

export function normalizeControlPlaneLoginName(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

export async function hashControlPlanePassword(password: string) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

export async function verifyControlPlanePassword(password: string, hash: string) {
  const [scheme, salt, expected] = hash.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const expectedBuffer = Buffer.from(expected, "base64url");
  return expectedBuffer.length === derived.length && crypto.timingSafeEqual(expectedBuffer, derived);
}
