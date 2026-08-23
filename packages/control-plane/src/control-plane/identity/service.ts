import crypto from "node:crypto";
import { z } from "zod";
import {
  ControlPlanePublicIdentityDocumentSchema,
  ControlPlanePublicIdentityPayloadSchema,
  CONTROL_PLANE_ACCESS_PROTOCOL_VERSION,
  controlPlaneIdentitySigningInput,
  type ControlPlanePublicCapabilities,
} from "@task-handoff/protocol/control-plane-access";
import { acceptControlPlaneHandshake, outboundConnectionRegistrationSigningInput } from "@task-handoff/cloud-contracts";
import { JsonFile } from "../../shared/persistence/store.ts";

const IDENTITY_DOCUMENT_TTL_MS = 5 * 60 * 1000;

const ControlPlaneSigningIdentitySchema = z.object({
  algorithm: z.literal("Ed25519"),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  privateKeyPkcs8: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
}).strip();

type ControlPlaneSigningIdentity = z.infer<typeof ControlPlaneSigningIdentitySchema>;

function generateSigningIdentity(): ControlPlaneSigningIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) throw new Error("Generated Control Plane identity did not contain an Ed25519 public key.");
  return {
    algorithm: "Ed25519",
    publicKey: jwk.x,
    privateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  };
}

function publicKeyFingerprint(publicKey: string) {
  return `sha256:${crypto.createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export class ControlPlaneIdentityService {
  private readonly identity: JsonFile<ControlPlaneSigningIdentity>;
  private readonly controlPlaneId: () => string;

  constructor(
    identityPath: string,
    controlPlaneId: () => string,
    logger?: (message: string, details: Record<string, unknown>) => void,
  ) {
    this.controlPlaneId = controlPlaneId;
    this.identity = new JsonFile(identityPath, generateSigningIdentity, {
      schema: ControlPlaneSigningIdentitySchema,
      logger,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  }

  init() {
    this.identity.init();
    this.privateKey();
  }

  publicDocument(authentication: "required" | "disabled", now = Date.now()) {
    const identity = this.identity.get();
    const capabilities: ControlPlanePublicCapabilities = {
      authentication,
      aiSessions: true,
      nodes: true,
      instanceBoard: true,
      triggers: true,
      ...(authentication === "required" ? {
        accessManagement: {
          userManagement: {
            users: true,
            identities: true,
            sessions: true,
          },
          authentication: {
            externalIdentity: {
              oidc: true,
              oauthAdapters: ["github"],
            },
          },
          authorization: {
            customRoles: true,
            nodeScopes: true,
            authorizationRevisions: true,
          },
        },
      } : {}),
    };
    const payload = ControlPlanePublicIdentityPayloadSchema.parse({
      version: 1,
      kind: "control-plane",
      controlPlaneId: this.controlPlaneId(),
      publicKey: {
        algorithm: "Ed25519",
        encoding: "base64url",
        value: identity.publicKey,
        fingerprint: publicKeyFingerprint(identity.publicKey),
      },
      capabilities,
      protocolVersion: CONTROL_PLANE_ACCESS_PROTOCOL_VERSION,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + IDENTITY_DOCUMENT_TTL_MS).toISOString(),
    });
    const signature = crypto.sign(
      null,
      Buffer.from(controlPlaneIdentitySigningInput(payload)),
      this.privateKey(),
    ).toString("base64url");
    return ControlPlanePublicIdentityDocumentSchema.parse({ data: { payload, signature } });
  }

  publicIdentity() {
    const identity = this.identity.get();
    return {
      controlPlaneId: this.controlPlaneId(),
      algorithm: identity.algorithm,
      publicKey: identity.publicKey,
      fingerprint: publicKeyFingerprint(identity.publicKey),
    } as const;
  }

  signCloudBindingChallenge(payload: unknown) {
    return crypto.sign(
      null,
      Buffer.from(`task-handoff:cloud-binding-challenge:v1\n${canonicalJson(payload)}`),
      this.privateKey(),
    ).toString("base64url");
  }

  signCloudOutboundRegistration(payload: unknown) {
    return crypto.sign(null, Buffer.from(outboundConnectionRegistrationSigningInput(payload)), this.privateKey()).toString("base64url");
  }

  acceptCloudAccessHandshake(ticket: unknown, clientHello: unknown) {
    const identity = this.publicIdentity();
    return acceptControlPlaneHandshake({
      ticket,
      clientHello,
      controlPlaneFingerprint: identity.fingerprint,
      controlPlanePrivateKey: this.privateKey(),
    });
  }

  private privateKey() {
    const identity = this.identity.get();
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(identity.privateKeyPkcs8, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    const derivedPublic = crypto.createPublicKey(privateKey).export({ format: "jwk" });
    if (derivedPublic.x !== identity.publicKey) {
      throw new Error("Stored Control Plane signing identity public and private keys do not match.");
    }
    return privateKey;
  }
}
