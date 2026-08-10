import crypto from "node:crypto";
import { z } from "zod";
import { JsonFile, createId } from "../../shared/persistence/store.ts";
import type { ControlPlaneIdentityService } from "../identity/service.ts";

const CloudConnectivityStateSchema = z.object({
  version: z.literal(1),
  serviceOrigin: z.string().url(),
  status: z.enum(["unbound", "pending-claim", "active", "pending-revocation", "clone-conflict"]),
  remoteAccessEnabled: z.boolean(),
  accountId: z.string().optional(),
  bindingId: z.string().optional(),
  bindingRevision: z.number().int().positive().optional(),
  backgroundCredential: z.string().min(32).optional(),
  updatedAt: z.string().datetime(),
  connectionEpoch: z.number().int().nonnegative().default(0),
}).strip();

export type CloudConnectivityState = z.infer<typeof CloudConnectivityStateSchema>;

type ChallengeEntry = {
  digest: Buffer;
  payload: ReturnType<CloudConnectivityService["challengePayload"]>;
  expiresAtMs: number;
};

export class CloudConnectivityService {
  private readonly state: JsonFile<CloudConnectivityState>;
  private readonly challenges = new Map<string, ChallengeEntry>();
  private readonly identity: ControlPlaneIdentityService;
  private readonly serviceOrigin: string;
  private readonly clock: () => number;

  constructor(options: { statePath: string; identity: ControlPlaneIdentityService; serviceOrigin: string; clock?: () => number }) {
    this.identity = options.identity;
    this.serviceOrigin = new URL(options.serviceOrigin).origin;
    this.clock = options.clock ?? Date.now;
    this.state = new JsonFile<CloudConnectivityState>(options.statePath, () => ({ version: 1, serviceOrigin: this.serviceOrigin, status: "unbound", remoteAccessEnabled: true, updatedAt: new Date(this.clock()).toISOString(), connectionEpoch: 0 }), {
      schema: CloudConnectivityStateSchema,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  }

  init() {
    this.state.init();
    const current = this.state.get();
    if (current.serviceOrigin !== this.serviceOrigin) throw cloudError("CLOUD_SERVICE_ORIGIN_CHANGED", "Cloud service origin does not match persisted binding authority.");
  }

  snapshot() {
    const { backgroundCredential: _secret, connectionEpoch: _internalEpoch, ...safe } = this.state.get();
    return { ...safe, identity: this.identity.publicIdentity(), hasBackgroundCredential: Boolean(_secret) };
  }

  createChallenge() {
    const current = this.state.get();
    if (["active", "pending-revocation", "clone-conflict"].includes(current.status)) throw cloudError(current.status === "active" ? "CONTROL_PLANE_ALREADY_BOUND" : "BINDING_STATE_CONFLICT", "Existing cloud binding must be resolved first.");
    this.prune();
    const challengeId = createId("binding_challenge");
    const challengeCode = crypto.randomBytes(32).toString("base64url");
    const payload = this.challengePayload(challengeId);
    this.challenges.set(challengeId, { digest: digest(challengeCode), payload, expiresAtMs: Date.parse(payload.expiresAt) });
    this.state.put({ ...current, status: "pending-claim", updatedAt: new Date(this.clock()).toISOString() });
    return { challengeCode: `${challengeId}.${challengeCode}`, authorizationUrl: `${this.serviceOrigin}/bindings/authorize`, payload, signature: this.identity.signCloudBindingChallenge(payload) };
  }

  consumeChallenge(input: { challengeCode: string; controlPlaneId: string; fingerprint: string }) {
    const separator = input.challengeCode.indexOf(".");
    const challengeId = input.challengeCode.slice(0, separator);
    const secret = input.challengeCode.slice(separator + 1);
    const entry = this.challenges.get(challengeId);
    if (entry) this.challenges.delete(challengeId);
    if (!entry || entry.expiresAtMs <= this.clock() || !safeEqual(entry.digest, digest(secret))) throw cloudError("BINDING_CHALLENGE_INVALID_OR_CONSUMED", "Binding challenge is invalid, expired, or consumed.");
    if (entry.payload.controlPlaneId !== input.controlPlaneId || entry.payload.publicKeyFingerprint !== input.fingerprint) throw cloudError("BINDING_IDENTITY_CONFLICT", "Binding challenge identity does not match.");
    return entry.payload;
  }

  activate(input: { accountId: string; bindingId: string; bindingRevision: number; backgroundCredential: string }) {
    const current = this.state.get();
    if (current.status === "active") {
      if (current.accountId === input.accountId && current.bindingId === input.bindingId && current.bindingRevision === input.bindingRevision) return this.snapshot();
      throw cloudError("CONTROL_PLANE_ALREADY_BOUND", "Control Plane is already bound to another account.");
    }
    if (current.status !== "pending-claim") throw cloudError("BINDING_STATE_CONFLICT", "Control Plane has no pending binding claim.");
    this.state.put({ ...current, status: "active", remoteAccessEnabled: true, ...input, updatedAt: new Date(this.clock()).toISOString() });
    return this.snapshot();
  }

  setRemoteAccess(enabled: boolean) {
    const current = this.state.get();
    this.state.put({ ...current, remoteAccessEnabled: enabled, updatedAt: new Date(this.clock()).toISOString() });
    return this.snapshot();
  }

  beginRevocation() {
    const current = this.state.get();
    if (current.status === "unbound") return this.snapshot();
    this.challenges.clear();
    this.state.put({ ...current, status: "pending-revocation", remoteAccessEnabled: false, updatedAt: new Date(this.clock()).toISOString() });
    return this.snapshot();
  }

  confirmRevocation() {
    const current = this.state.get();
    this.state.put({ version: 1, serviceOrigin: current.serviceOrigin, status: "unbound", remoteAccessEnabled: false, updatedAt: new Date(this.clock()).toISOString(), connectionEpoch: current.connectionEpoch });
    return this.snapshot();
  }

  markCloneConflict() {
    const current = this.state.get();
    this.challenges.clear();
    this.state.put({ ...current, status: "clone-conflict", remoteAccessEnabled: false, backgroundCredential: undefined, updatedAt: new Date(this.clock()).toISOString() });
    return this.snapshot();
  }

  backgroundCredential() {
    const current = this.state.get();
    return current.status === "active" && current.remoteAccessEnabled ? current.backgroundCredential : undefined;
  }

  nextConnectionEpoch() {
    const current = this.state.get();
    const connectionEpoch = current.connectionEpoch + 1;
    this.state.put({ ...current, connectionEpoch, updatedAt: new Date(this.clock()).toISOString() });
    return connectionEpoch;
  }

  private challengePayload(challengeId: string) {
    const identity = this.identity.publicIdentity();
    const issuedAt = this.clock();
    return {
      protocolVersion: "2026-08-10",
      audience: "task-handoff:binding",
      serviceOrigin: this.serviceOrigin,
      challengeId,
      controlPlaneId: identity.controlPlaneId,
      publicKey: identity.publicKey,
      publicKeyFingerprint: identity.fingerprint,
      nonce: crypto.randomBytes(24).toString("base64url"),
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 5 * 60_000).toISOString(),
    } as const;
  }

  private prune() {
    const now = this.clock();
    for (const [id, entry] of this.challenges) if (entry.expiresAtMs <= now) this.challenges.delete(id);
  }
}

function digest(value: string) {
  return crypto.createHash("sha256").update(value).digest();
}

function safeEqual(left: Buffer, right: Buffer) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cloudError(code: string, message: string) {
  return Object.assign(new Error(message), { code, statusCode: code.includes("CONFLICT") || code.includes("BOUND") ? 409 : 400 });
}
