import { z } from "zod";
import { createId, createSecret } from "../../shared/persistence/store.ts";
import { sha256Hex } from "../../shared/security/node-agent-auth.ts";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";
import { NodeAgentPairingCompleteSchema, NodeAgentPairingInviteSchema } from "./schemas.ts";
import { NodeAgentIdentityStore } from "./store.ts";
import type { NodeAgentIdentity, NodeAgentRemoteControlPlane, PublicNodeAgentRemoteControlPlane } from "./types.ts";

const NODE_AGENT_PAIRING_INVITE_TTL_MS = 10 * 60 * 1000;

function now() {
  return new Date().toISOString();
}

export class NodeAgentIdentityService {
  private readonly store: NodeAgentIdentityStore;

  constructor(paths: NodeAgentStorePaths) {
    this.store = new NodeAgentIdentityStore(paths);
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
      ...(input.controlPlaneUrl ? { controlPlaneUrl: input.controlPlaneUrl } : {}),
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
    const remote: NodeAgentRemoteControlPlane = {
      id: input.controlPlaneId || createId("cp"),
      keyId: createId("key"),
      ...(input.controlPlaneName || invite.controlPlaneName ? { name: input.controlPlaneName || invite.controlPlaneName } : {}),
      ...(input.controlPlaneUrl || invite.controlPlaneUrl ? { url: input.controlPlaneUrl || invite.controlPlaneUrl } : {}),
      secret: createSecret(),
      pairedAt: timestamp,
      updatedAt: timestamp,
      active: true,
    };
    this.store.write({
      ...current,
      pairingInvites: (current.pairingInvites || []).filter((item) => item.tokenHash !== tokenHash),
      remoteControlPlanes: [...(current.remoteControlPlanes || []).filter((item) => item.id !== remote.id), remote],
    });
    return remote;
  }

  upsertRemoteControlPlane(remote: NodeAgentRemoteControlPlane) {
    const current = this.store.read() || this.newIdentity();
    const normalizedUrl = remote.url?.replace(/\/$/, "");
    this.store.write({
      ...current,
      remoteControlPlanes: [
        ...(current.remoteControlPlanes || []).filter((item) => item.id !== remote.id && (!normalizedUrl || item.url?.replace(/\/$/, "") !== normalizedUrl)),
        remote,
      ],
    });
    return remote;
  }

  createRemoteControlPlane(input: { url: string; name?: string; active?: boolean }) {
    const timestamp = now();
    return {
      id: createId("cp"),
      keyId: createId("key"),
      ...(input.name ? { name: input.name } : {}),
      url: input.url,
      secret: createSecret(),
      pairedAt: timestamp,
      updatedAt: timestamp,
      active: input.active !== false,
    } satisfies NodeAgentRemoteControlPlane;
  }

  configuredRemoteControlPlanes() {
    return this.store.read()?.remoteControlPlanes || [];
  }

  listRemoteControlPlanes(currentKeyId = ""): PublicNodeAgentRemoteControlPlane[] {
    return (this.store.read()?.remoteControlPlanes || [])
      .map(({ secret: _secret, ...remote }) => ({ ...remote, current: Boolean(currentKeyId && remote.keyId === currentKeyId) }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.updatedAt.localeCompare(a.updatedAt));
  }

  deleteRemoteControlPlane(keyId: string, currentKeyId = "") {
    if (currentKeyId && keyId === currentKeyId) {
      const error = new Error("Cannot delete the key currently used by this control-plane connection.");
      Object.assign(error, { statusCode: 409, code: "NODE_AGENT_REMOTE_KEY_IN_USE" });
      throw error;
    }
    const current = this.store.read();
    if (!current) return false;
    const nextRemotes = (current.remoteControlPlanes || []).filter((remote) => remote.keyId !== keyId);
    if (nextRemotes.length === (current.remoteControlPlanes || []).length) return false;
    this.store.write({ ...current, remoteControlPlanes: nextRemotes });
    return true;
  }

  remoteSecrets(overrideSecret?: string, overrideKeyId?: string) {
    return [
      ...(this.store.read()?.remoteControlPlanes || []).map((remote) => ({ keyId: remote.keyId, secret: remote.secret })),
      ...(overrideSecret && overrideKeyId ? [{ keyId: overrideKeyId, secret: overrideSecret }] : []),
    ];
  }

  reverseTunnelSecret(controlPlaneUrl?: string, overrideSecret?: string, overrideKeyId?: string) {
    if (overrideSecret && overrideKeyId) return { keyId: overrideKeyId, secret: overrideSecret };
    const remotes = this.store.read()?.remoteControlPlanes || [];
    if (!remotes.length) return undefined;
    if (controlPlaneUrl) {
      const normalizedUrl = controlPlaneUrl.replace(/\/$/, "");
      const exact = remotes.find((remote) => remote.url?.replace(/\/$/, "") === normalizedUrl);
      if (exact) return { keyId: exact.keyId, secret: exact.secret };
    }
    const latest = [...remotes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return latest ? { keyId: latest.keyId, secret: latest.secret } : undefined;
  }

  private newIdentity(): NodeAgentIdentity {
    return { nodeId: this.resolveNodeId(), createdAt: now(), updatedAt: now(), pairingInvites: [], remoteControlPlanes: [] };
  }

  private writeNodeId(nodeId: string) {
    const current = this.store.read();
    this.store.write({
      ...(current || { createdAt: now() }),
      nodeId,
      updatedAt: now(),
      pairingInvites: current?.pairingInvites || [],
      remoteControlPlanes: current?.remoteControlPlanes || [],
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
