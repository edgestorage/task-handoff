import { sha256 } from "@noble/hashes/sha256";

const encoder = new TextEncoder();

export function sha256Bytes(value: string | Uint8Array) {
  return sha256(typeof value === "string" ? encoder.encode(value) : value);
}

export function sha256Hex(value: string | Uint8Array) {
  return Array.from(sha256Bytes(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function base64Encode(value: Uint8Array) {
  // btoa only accepts strings; use 3-byte-aligned chunks so large binary bodies
  // do not exceed the argument limit of String.fromCharCode or gain mid-stream padding.
  const chunkSize = 3 * 8192;
  const encoded: string[] = [];
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    encoded.push(btoa(String.fromCharCode(...value.subarray(offset, offset + chunkSize))));
  }
  return encoded.join("");
}

export function base64Decode(value: string) {
  const decoded = atob(value);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const bufferConstructor = (globalThis as { Buffer?: { from(value: Uint8Array): Uint8Array } }).Buffer;
  return bufferConstructor ? bufferConstructor.from(bytes) : bytes;
}
