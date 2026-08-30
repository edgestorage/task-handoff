import crypto from "node:crypto";
import { z } from "zod";
import { JsonFile } from "../../shared/persistence/store.ts";

const SecretKeySchema = z.object({
  version: z.literal(1),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export class ControlPlaneSecretBox {
  private readonly keyFile: JsonFile<{ version: 1; key: string }>;

  constructor(filePath: string) {
    this.keyFile = new JsonFile(filePath, () => ({ version: 1, key: crypto.randomBytes(32).toString("base64url") }), {
      schema: SecretKeySchema,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  }

  init() {
    this.keyFile.init();
  }

  seal(plaintext: string) {
    const key = Buffer.from(this.keyFile.get().key, "base64url");
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", nonce.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  }

  open(envelope: string) {
    const [version, nonceValue, ciphertextValue, tagValue] = envelope.split(".");
    if (version !== "v1" || !nonceValue || !ciphertextValue || !tagValue) throw new Error("Unsupported encrypted secret envelope.");
    const key = Buffer.from(this.keyFile.get().key, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(nonceValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
  }
}
