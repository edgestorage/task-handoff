const OPENSSH_V1_MAGIC = "openssh-key-v1\0";
const OPENSSH_PRIVATE_KEY_HEADER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_PRIVATE_KEY_FOOTER = "-----END OPENSSH PRIVATE KEY-----";
const ED25519_KEY_TYPE = "ssh-ed25519";

const textEncoder = new TextEncoder();

export type GeneratedSshKeyPair = {
  algorithm: typeof ED25519_KEY_TYPE;
  comment: string;
  privateKey: string;
  publicKey: string;
  fingerprint: string;
};

type Ed25519Jwk = JsonWebKey & { d?: string; x?: string };

function bytesOf(value: string) {
  return textEncoder.encode(value);
}

function uint32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, false);
  return bytes;
}

function concatBytes(...parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** SSH wire encoding: uint32 length prefix followed by the raw bytes. */
function sshString(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? bytesOf(value) : value;
  return concatBytes(uint32(bytes.length), bytes);
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function wrapBase64(value: string, width = 70) {
  const lines: string[] = [];
  for (let index = 0; index < value.length; index += width) lines.push(value.slice(index, index + width));
  return lines.join("\n");
}

function ed25519PublicKeyBlob(publicKey: Uint8Array) {
  return concatBytes(sshString(ED25519_KEY_TYPE), sshString(publicKey));
}

/**
 * Generates an Ed25519 key pair entirely in the browser and serializes it as an
 * unencrypted OpenSSH private key (`openssh-key-v1`) plus an `authorized_keys`
 * public key line, matching the output shape of `ssh-keygen -t ed25519`.
 */
export async function generateEd25519SshKey(comment = ""): Promise<GeneratedSshKeyPair> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("WebCrypto is unavailable in this environment.");
  let keyPair: CryptoKeyPair;
  try {
    keyPair = await cryptoApi.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  } catch {
    throw new Error("This environment cannot generate Ed25519 keys.");
  }
  const jwk = await cryptoApi.subtle.exportKey("jwk", keyPair.privateKey) as Ed25519Jwk;
  if (typeof jwk.d !== "string" || typeof jwk.x !== "string") throw new Error("Failed to export the generated private key.");

  const seed = decodeBase64Url(jwk.d);
  const publicKey = decodeBase64Url(jwk.x);
  const publicKeyBlob = ed25519PublicKeyBlob(publicKey);

  const checkInt = new Uint8Array(4);
  cryptoApi.getRandomValues(checkInt);
  const check = new DataView(checkInt.buffer).getUint32(0, false);
  const privateSection = concatBytes(
    uint32(check),
    uint32(check),
    sshString(ED25519_KEY_TYPE),
    sshString(publicKey),
    sshString(concatBytes(seed, publicKey)),
    sshString(comment),
  );
  const paddingLength = (8 - (privateSection.length % 8)) % 8;
  const padding = new Uint8Array(paddingLength);
  for (let index = 0; index < paddingLength; index += 1) padding[index] = index + 1;

  const privateKeyBlob = concatBytes(
    bytesOf(OPENSSH_V1_MAGIC),
    sshString("none"),
    sshString("none"),
    sshString(new Uint8Array(0)),
    uint32(1),
    sshString(publicKeyBlob),
    sshString(concatBytes(privateSection, padding)),
  );

  const fingerprintBytes = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", publicKeyBlob));
  return {
    algorithm: ED25519_KEY_TYPE,
    comment,
    privateKey: `${OPENSSH_PRIVATE_KEY_HEADER}\n${wrapBase64(encodeBase64(privateKeyBlob))}\n${OPENSSH_PRIVATE_KEY_FOOTER}\n`,
    publicKey: comment ? `${ED25519_KEY_TYPE} ${encodeBase64(publicKeyBlob)} ${comment}` : `${ED25519_KEY_TYPE} ${encodeBase64(publicKeyBlob)}`,
    fingerprint: `SHA256:${encodeBase64(fingerprintBytes).replace(/=+$/, "")}`,
  };
}
