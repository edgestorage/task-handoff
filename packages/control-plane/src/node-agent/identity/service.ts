import { z } from "zod";
import { createId, createSecret } from "../../shared/persistence/store.ts";
import { sha256Hex } from "../../shared/security/node-agent-auth.ts";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";
import { NodeAgentPairingCompleteSchema, NodeAgentPairingInviteSchema } from "./schemas.ts";
import { NodeAgentIdentityStore } from "./store.ts";
import type { NodeAgentControlPlaneConnection, NodeAgentControlPlanePairing, NodeAgentIdentity, PublicNodeAgentControlPlanePairing } from "./types.ts";

type StagedControlPlaneConnection = {
  pairing: NodeAgentControlPlanePairing;
  connection: NodeAgentControlPlaneConnection;
  replacedConnections: NodeAgentControlPlaneConnection[];
};

const NODE_AGENT_PAIRING_INVITE_TTL_MS = 10 * 60 * 1000;

function now() {
  return new Date().toISOString();
}

export class NodeAgentIdentityService {
  private readonly store: NodeAgentIdentityStore;
  private readonly controlPlaneConnectionOperations = new Map<string, Promise<void>>();

  constructor(paths: NodeAgentStorePaths) {
    this.store = new NodeAgentIdentityStore(paths);
  }

  async runControlPlaneConnectionOperation<T>(controlPlaneUrl: string, operation: () => Promise<T>): Promise<T> {
    const key = controlPlaneUrl.replace(/\/$/, "");
    const previous = this.controlPlaneConnectionOperations.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.controlPlaneConnectionOperations.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.controlPlaneConnectionOperations.get(key) === current) {
        this.controlPlaneConnectionOperations.delete(key);
      }
    }
  }

  resolveNodeId(explicitNodeId?: string) {
    if (explicitNodeId?.trim()) {
      this.writeNodeId(explicitNodeId.trim());
      return explicitNodeId.trim();
    }
    const existing = this.store.read();
    if (existing?.nodeId) return existing.nodeId;
    const nodeId = createId("node");
    this.writeNodeId(nodeId);
    return nodeId;
  }

  createPairingInvite(input: z.infer<typeof NodeAgentPairingInviteSchema>) {
    const current = this.prunePairingInvites(this.store.read() || this.newIdentity());
    const createdAt = now();
    const expiresAt = new Date(Date.now() + (input.expiresInMs || NODE_AGENT_PAIRING_INVITE_TTL_MS)).toISOString();
    const token = createSecret();
    const invite = {
      tokenHash: sha256Hex(token),
      createdAt,
      expiresAt,
      ...(input.controlPlaneName ? { controlPlaneName: input.controlPlaneName } : {}),
    };
    this.store.write({ ...current, pairingInvites: [...(current.pairingInvites || []), invite] });
    return { ...invite, token };
  }

  completePairingInvite(input: z.infer<typeof NodeAgentPairingCompleteSchema>) {
    const current = this.prunePairingInvites(this.store.read() || this.newIdentity());
    const tokenHash = sha256Hex(input.joinToken);
    const invite = (current.pairingInvites || []).find((item) => item.tokenHash === tokenHash);
    if (!invite) {
      const error = new Error("Node agent pairing invite is invalid or expired.");
      Object.assign(error, { statusCode: 401, code: "NODE_AGENT_PAIRING_INVITE_INVALID" });
      throw error;
    }
    const timestamp = now();
    const pairing: NodeAgentControlPlanePairing = {
      id: input.controlPlaneId || createId("cp"),
      keyId: createId("key"),
      ...(input.controlPlaneName || invite.controlPlaneName ? { name: input.controlPlaneName || invite.controlPlaneName } : {}),
      secret: createSecret(),
      pairedAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.write({
      ...current,
      pairingInvites: (current.pairingInvites || []).filter((item) => item.tokenHash !== tokenHash),
      controlPlanePairings: [...(current.controlPlanePairings || []).filter((item) => item.id !== pairing.id), pairing],
    });
    return pairing;
  }

  stageControlPlaneConnection(input: { url: string; name?: string; enabled?: boolean }): StagedControlPlaneConnection {
    const { pairing, connection } = this.createControlPlaneConnection(input);
    const current = this.store.read() || this.newIdentity();
    const normalizedUrl = connection.url.replace(/\/$/, "");
    const replacedConnections = (current.controlPlaneConnections || []).filter(
      (item) => item.id === connection.id || item.url.replace(/\/$/, "") === normalizedUrl,
    );
    this.store.write({
      ...current,
      controlPlanePairings: [
        ...(current.controlPlanePairings || []).filter((item) => item.keyId !== pairing.keyId),
        pairing,
      ],
      controlPlaneConnections: [
        ...(current.controlPlaneConnections || []).filter((item) => item.id !== connection.id && item.url.replace(/\/$/, "") !== normalizedUrl),
        connection,
      ],
    });
    return { pairing, connection, replacedConnections };
  }

  commitControlPlaneConnection(staged: StagedControlPlaneConnection, input: { name?: string } = {}) {
    const current = this.store.read() || this.newIdentity();
    const pairing = { ...staged.pairing, ...(input.name ? { name: input.name } : {}) };
    const connection = { ...staged.connection, ...(input.name ? { name: input.name } : {}) };
    const activePairingKeyIds = new Set((current.controlPlaneConnections || []).map((item) => item.pairingKeyId));
    const replacedPairingKeyIds = new Set(staged.replacedConnections.map((item) => item.pairingKeyId));
    this.store.write({
      ...current,
      controlPlanePairings: [
        ...(current.controlPlanePairings || []).filter((item) => (
          item.keyId !== pairing.keyId
          && (!replacedPairingKeyIds.has(item.keyId) || activePairingKeyIds.has(item.keyId))
        )),
        pairing,
      ],
      controlPlaneConnections: [
        ...(current.controlPlaneConnections || []).filter((item) => item.id !== connection.id),
        connection,
      ],
    });
    return { pairing, connection };
  }

  rollbackControlPlaneConnection(staged: StagedControlPlaneConnection) {
    const current = this.store.read();
    if (!current) return;
    const restoredConnectionIds = new Set(staged.replacedConnections.map((connection) => connection.id));
    this.store.write({
      ...current,
      controlPlanePairings: (current.controlPlanePairings || []).filter((pairing) => pairing.keyId !== staged.pairing.keyId),
      controlPlaneConnections: [
        ...(current.controlPlaneConnections || []).filter(
          (connection) => connection.id !== staged.connection.id && !restoredConnectionIds.has(connection.id),
        ),
        ...staged.replacedConnections,
      ],
    });
  }

  private createControlPlaneConnection(input: { url: string; name?: string; enabled?: boolean }) {
    const timestamp = now();
    const pairing = {
      id: createId("cp"),
      keyId: createId("key"),
      ...(input.name ? { name: input.name } : {}),
      secret: createSecret(),
      pairedAt: timestamp,
      updatedAt: timestamp,
    } satisfies NodeAgentControlPlanePairing;
    const connection = {
      id: createId("connection"),
      pairingKeyId: pairing.keyId,
      ...(input.name ? { name: input.name } : {}),
      url: input.url,
      enabled: input.enabled !== false,
      createdAt: timestamp,
      updatedAt: timestamp,
    } satisfies NodeAgentControlPlaneConnection;
    return { pairing, connection };
  }

  resolvedControlPlaneAccess() {
    const identity = this.store.read();
    const pairings = new Map((identity?.controlPlanePairings || [])
      .filter((pairing) => !pairing.revokedAt)
      .map((pairing) => [pairing.keyId, pairing]));
    const connections = identity?.controlPlaneConnections || [];
    return {
      hasPersistedAccess: connections.length > 0 || pairings.size > 0,
      connections: connections.map((connection) => ({
        connection,
        pairing: pairings.get(connection.pairingKeyId),
      })),
    };
  }

  listControlPlanePairings(currentKeyId = ""): PublicNodeAgentControlPlanePairing[] {
    return (this.store.read()?.controlPlanePairings || [])
      .filter((pairing) => !pairing.revokedAt)
      .map(({ secret: _secret, ...pairing }) => ({ ...pairing, current: Boolean(currentKeyId && pairing.keyId === currentKeyId) }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.updatedAt.localeCompare(a.updatedAt));
  }

  listControlPlaneConnections() {
    return [...(this.store.read()?.controlPlaneConnections || [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  deleteControlPlanePairing(keyId: string, currentKeyId = "") {
    if (currentKeyId && keyId === currentKeyId) {
      const error = new Error("Cannot delete the pairing used to authenticate the current request.");
      Object.assign(error, { statusCode: 409, code: "NODE_AGENT_PAIRING_CURRENT_REQUEST" });
      throw error;
    }
    const current = this.store.read();
    if (!current) return false;
    if ((current.controlPlaneConnections || []).some((connection) => connection.pairingKeyId === keyId)) {
      throw Object.assign(new Error("Cannot delete a pairing used by a configured control-plane connection."), { statusCode: 409, code: "NODE_AGENT_PAIRING_IN_USE" });
    }
    const nextPairings = (current.controlPlanePairings || []).filter((pairing) => pairing.keyId !== keyId);
    if (nextPairings.length === (current.controlPlanePairings || []).length) return false;
    this.store.write({ ...current, controlPlanePairings: nextPairings });
    return true;
  }

  revokeCurrentControlPlanePairing(currentKeyId: string) {
    if (!currentKeyId) {
      throw Object.assign(new Error("Current paired-HMAC authentication is required to revoke this pairing."), {
        statusCode: 403,
        code: "NODE_AGENT_PAIRING_SELF_REVOKE_HMAC_REQUIRED",
      });
    }
    const current = this.store.read();
    const pairing = current?.controlPlanePairings?.find((candidate) => candidate.keyId === currentKeyId);
    if (!current || !pairing) {
      throw Object.assign(new Error("The current control-plane pairing no longer exists."), {
        statusCode: 404,
        code: "NODE_AGENT_PAIRING_NOT_FOUND",
      });
    }
    if (pairing.revokedAt) {
      return { keyId: currentKeyId, revoked: true as const, revokedAt: pairing.revokedAt };
    }
    if ((current.controlPlaneConnections || []).some((connection) => connection.pairingKeyId === currentKeyId)) {
      throw Object.assign(new Error("Cannot revoke a pairing used by a configured control-plane connection."), {
        statusCode: 409,
        code: "NODE_AGENT_PAIRING_IN_USE",
      });
    }
    const revokedAt = now();
    this.store.write({
      ...current,
      controlPlanePairings: current.controlPlanePairings.map((candidate) => candidate.keyId === currentKeyId
        ? { ...candidate, revokedAt, updatedAt: revokedAt }
        : candidate),
    });
    return { keyId: currentKeyId, revoked: true as const, revokedAt };
  }

  deleteControlPlaneConnection(connectionId: string) {
    const current = this.store.read();
    if (!current) return false;
    const nextConnections = (current.controlPlaneConnections || []).filter((connection) => connection.id !== connectionId);
    if (nextConnections.length === (current.controlPlaneConnections || []).length) return false;
    this.store.write({ ...current, controlPlaneConnections: nextConnections });
    return true;
  }

  remoteSecrets(overrideSecret?: string, overrideKeyId?: string, includeRevoked = false) {
    return [
      ...(this.store.read()?.controlPlanePairings || [])
        .filter((pairing) => includeRevoked || !pairing.revokedAt)
        .map((pairing) => ({ keyId: pairing.keyId, secret: pairing.secret })),
      ...(overrideSecret && overrideKeyId ? [{ keyId: overrideKeyId, secret: overrideSecret }] : []),
    ];
  }

  isRevokedPairing(keyId: string) {
    return Boolean(this.store.read()?.controlPlanePairings?.some((pairing) => pairing.keyId === keyId && pairing.revokedAt));
  }

  reverseTunnelSecret(controlPlaneUrl?: string, overrideSecret?: string, overrideKeyId?: string) {
    if (overrideSecret && overrideKeyId) return { keyId: overrideKeyId, secret: overrideSecret };
    const identity = this.store.read();
    const pairings = (identity?.controlPlanePairings || []).filter((pairing) => !pairing.revokedAt);
    if (!pairings.length) return undefined;
    if (controlPlaneUrl) {
      const normalizedUrl = controlPlaneUrl.replace(/\/$/, "");
      const connection = (identity?.controlPlaneConnections || []).find((item) => item.url.replace(/\/$/, "") === normalizedUrl);
      const exact = connection && pairings.find((pairing) => pairing.keyId === connection.pairingKeyId);
      if (exact) return { keyId: exact.keyId, secret: exact.secret };
    }
    const latest = [...pairings].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return latest ? { keyId: latest.keyId, secret: latest.secret } : undefined;
  }

  private newIdentity(): NodeAgentIdentity {
    return { nodeId: this.resolveNodeId(), createdAt: now(), updatedAt: now(), pairingInvites: [], controlPlanePairings: [], controlPlaneConnections: [] };
  }

  private writeNodeId(nodeId: string) {
    const current = this.store.read();
    this.store.write({
      ...(current || { createdAt: now() }),
      nodeId,
      updatedAt: now(),
      pairingInvites: current?.pairingInvites || [],
      controlPlanePairings: current?.controlPlanePairings || [],
      controlPlaneConnections: current?.controlPlaneConnections || [],
    });
  }

  private prunePairingInvites(identity: NodeAgentIdentity) {
    const nowMs = Date.now();
    return { ...identity, pairingInvites: (identity.pairingInvites || []).filter((invite) => Date.parse(invite.expiresAt) > nowMs) };
  }
}

export function assertHttpControlPlaneUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    const error = new Error("Control-plane URL must use http or https.");
    Object.assign(error, { statusCode: 400, code: "NODE_AGENT_REMOTE_CONTROL_PLANE_URL_INVALID" });
    throw error;
  }
  return url.toString().replace(/\/$/, "");
}

export async function completeControlPlaneJoin(fetchImpl: typeof fetch, controlPlaneUrl: string, input: {
  joinToken: string;
  nodeId: string;
  nodeName?: string;
  keyId: string;
  secret: string;
  pairedAt: string;
}) {
  const response = await fetchImpl(new URL("/api/node-join/complete", controlPlaneUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = (await response.json().catch(() => ({}))) as { data?: { id?: unknown; name?: unknown }; error?: { message?: string; code?: string } };
  if (!response.ok) {
    const error = new Error(payload.error?.message || `Control-plane node join failed with HTTP ${response.status}.`);
    Object.assign(error, { statusCode: response.status, code: payload.error?.code || "NODE_AGENT_REMOTE_JOIN_FAILED" });
    throw error;
  }
  return payload.data || {};
}
