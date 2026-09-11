import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { JsonFile } from "../../shared/persistence/store.ts";

const EncodedKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const SecretKeyFileSchema = z.object({
  version: z.literal(1),
  keyId: z.string().regex(/^key_[A-Za-z0-9_-]{16}$/),
  key: EncodedKeySchema,
}).strict();

export const SecretEnvelopeSchema = z.string().regex(
  /^v1\.key_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/,
);

type SecretKeyFile = z.infer<typeof SecretKeyFileSchema>;

function keyId(key: Buffer) {
  return `key_${crypto.createHash("sha256").update(key).digest("base64url").slice(0, 16)}`;
}

function keyRecord(encoded = crypto.randomBytes(32).toString("base64url")): SecretKeyFile {
  const parsed = EncodedKeySchema.parse(encoded);
  const key = Buffer.from(parsed, "base64url");
  return { version: 1, keyId: keyId(key), key: parsed };
}

function secretError(code: string, message: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

export class SecretEnvelopeService {
  private readonly keyFile: JsonFile<SecretKeyFile>;
  private readonly keyPath: string;
  private readonly configuredKey: string | undefined;
  private active: SecretKeyFile | undefined;

  constructor(keyPath: string, options: { key?: string } = {}) {
    this.keyPath = keyPath;
    this.configuredKey = options.key ?? (process.env.TASK_HANDOFF_CONTROL_PLANE_ENCRYPTION_KEY?.trim() || undefined);
    this.keyFile = new JsonFile(keyPath, keyRecord, {
      schema: SecretKeyFileSchema,
      directoryMode: 0o700,
      fileMode: 0o600,
      rejectInvalid: true,
    });
  }

  init() {
    const configured = this.configuredKey ? keyRecord(this.configuredKey) : undefined;
    if (configured && !fs.existsSync(this.keyPath)) {
      fs.mkdirSync(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.dirname(this.keyPath), 0o700);
      this.active = configured;
      return;
    }

    try {
      this.keyFile.init();
      const stored = this.keyFile.get();
      if (configured && configured.keyId !== stored.keyId) {
        throw secretError(
          "CONTROL_PLANE_KEYSTORE_CONFLICT",
          "Configured Control Plane encryption key does not match the existing keystore.",
        );
      }
      this.active = configured || stored;
    } catch (error) {
      if ((error as { code?: string }).code === "CONTROL_PLANE_KEYSTORE_CONFLICT") throw error;
      throw secretError("CONTROL_PLANE_KEYSTORE_INVALID", "Control Plane encryption keystore is invalid.", error);
    }
  }

  currentKeyId() {
    return this.requireKey().keyId;
  }

  seal(plaintext: string, context: string) {
    const record = this.requireKey();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(record.key, "base64url"), nonce);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return SecretEnvelopeSchema.parse([
      "v1",
      record.keyId,
      nonce.toString("base64url"),
      ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join("."));
  }

  open(envelope: string, context: string) {
    const parsed = SecretEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      throw secretError("CONTROL_PLANE_SECRET_ENVELOPE_INVALID", "Stored Control Plane secret envelope is invalid.");
    }
    const [, envelopeKeyId, nonce, ciphertext, tag] = parsed.data.split(".");
    const record = this.requireKey();
    if (envelopeKeyId !== record.keyId) {
      throw secretError("CONTROL_PLANE_KEYSTORE_MISMATCH", "Control Plane secret requires an unavailable encryption key.");
    }
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(record.key, "base64url"), Buffer.from(nonce!, "base64url"));
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(tag!, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext!, "base64url")), decipher.final()]).toString("utf8");
    } catch (error) {
      throw secretError("CONTROL_PLANE_SECRET_AUTHENTICATION_FAILED", "Stored Control Plane secret could not be authenticated.", error);
    }
  }

  private requireKey() {
    if (!this.active) throw secretError("CONTROL_PLANE_KEYSTORE_NOT_INITIALIZED", "Control Plane encryption keystore is not initialized.");
    return this.active;
  }
}
