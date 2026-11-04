import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  NodeAgentControlPlaneConnectionCreateSchema,
  NodeAgentPairingCompleteSchema,
  NodeAgentPairingInviteSchema,
} from "./schemas.ts";
import {
  NodeAgentControlPlaneTrustDecisionSchema,
  NodeAgentControlPlaneTrustRetrySchema,
  NodeAgentControlPlaneTrustRevokeSchema,
} from "@task-handoff/protocol/node-agent-control-plane-trust";
import type {
  NodeAgentCloudControlPlanePin,
  NodeAgentCloudControlPlaneTrustDecisionResult,
  NodeAgentCloudControlPlaneTrustRequest,
} from "../cloud-relay/trust-types.ts";
import {
  assertHttpControlPlaneUrl,
  completeControlPlaneJoin,
  type NodeAgentIdentityService,
} from "./service.ts";

type ReverseTunnelAccess = {
  connectConfigured(): unknown;
  state(connectionId: string): Record<string, unknown> | undefined;
};

type Options = {
  identity: NodeAgentIdentityService;
  nodeId: string;
  nodeName(): string;
  fetchImpl: typeof fetch;
  reverseTunnels(): ReverseTunnelAccess | undefined;
  onTrustChanged?(change: {
    decision?: NodeAgentCloudControlPlaneTrustDecisionResult;
    revokedPin?: NodeAgentCloudControlPlanePin;
    retried?: NodeAgentCloudControlPlaneTrustRequest;
  }): void;
};

const StoredIdSchema = z.string().trim().min(1).max(160);

export function registerNodeAgentIdentityRoutes(app: FastifyInstance, options: Options) {
  const { identity, nodeId, fetchImpl } = options;

  app.post("/api/node-agent/pairing/invites", async (request, reply) => {
    const invite = identity.createPairingInvite(NodeAgentPairingInviteSchema.parse(request.body || {}));
    return reply.code(201).send({
      data: { nodeId, joinToken: invite.token, expiresAt: invite.expiresAt },
    });
  });

  app.post("/api/node-agent/pairing/complete", async (request, reply) => {
    const remote = identity.completePairingInvite(NodeAgentPairingCompleteSchema.parse(request.body));
    return reply.code(201).send({
      data: { nodeId, keyId: remote.keyId, secret: remote.secret, pairedAt: remote.pairedAt },
    });
  });

  app.get("/api/node-agent/control-plane-pairings", async (request) => ({
    data: identity.listControlPlanePairings(request.nodeAgentAuthKeyId),
  }));

  app.delete("/api/node-agent/control-plane-pairings/:keyId", async (request) => {
    const keyId = StoredIdSchema.parse((request.params as { keyId: string }).keyId);
    return { data: { deleted: identity.deleteControlPlanePairing(keyId, request.nodeAgentAuthKeyId) } };
  });

  app.delete("/api/node-agent/pairing/current", async (request) => ({
    data: identity.revokeCurrentControlPlanePairing(request.nodeAgentAuthKeyId || ""),
  }));

  app.get("/api/node-agent/control-plane-connections", async () => ({
    data: identity.listControlPlaneConnections().map((connection) => ({
      ...connection,
      ...(options.reverseTunnels()?.state(connection.id) || { status: connection.enabled ? "connecting" : "disabled" }),
    })),
  }));

  app.delete("/api/node-agent/control-plane-connections/:connectionId", async (request) => {
    const connectionId = StoredIdSchema.parse((request.params as { connectionId: string }).connectionId);
    const deleted = identity.deleteControlPlaneConnection(connectionId);
    if (deleted) options.reverseTunnels()?.connectConfigured();
    return { data: { deleted } };
  });

  app.post("/api/node-agent/control-plane-connections", async (request, reply) => {
    const input = NodeAgentControlPlaneConnectionCreateSchema.parse(request.body);
    const controlPlaneUrl = assertHttpControlPlaneUrl(input.controlPlaneUrl);
    return identity.runControlPlaneConnectionOperation(controlPlaneUrl, async () => {
      const staged = identity.stageControlPlaneConnection({
        url: controlPlaneUrl,
        ...(input.controlPlaneName ? { name: input.controlPlaneName } : {}),
        enabled: input.activate !== false,
      });
      let joined: Awaited<ReturnType<typeof completeControlPlaneJoin>>;
      try {
        joined = await completeControlPlaneJoin(fetchImpl, controlPlaneUrl, {
          joinToken: input.joinToken,
          nodeId,
          nodeName: options.nodeName(),
          keyId: staged.pairing.keyId,
          secret: staged.pairing.secret,
          pairedAt: staged.pairing.pairedAt,
        });
      } catch (error) {
        identity.rollbackControlPlaneConnection(staged);
        throw error;
      }
      identity.markControlPlaneConnectionRemoteAccepted(staged);
      const stored = identity.commitControlPlaneConnection(staged, {
        name: input.controlPlaneName || (typeof joined.name === "string" && joined.name ? joined.name : undefined),
      });
      let tunnelStatus: "disabled" | "saved" | "connecting" | "failed" = stored.connection.enabled ? "saved" : "disabled";
      let tunnelError: string | undefined;
      const reverseTunnels = options.reverseTunnels();
      if (reverseTunnels) {
        try {
          reverseTunnels.connectConfigured();
          if (stored.connection.enabled) tunnelStatus = "connecting";
        } catch (error) {
          tunnelStatus = "failed";
          tunnelError = error instanceof Error ? error.message : String(error);
        }
      }
      return reply.code(201).send({
        data: {
          pairing: identity.listControlPlanePairings().find((item) => item.keyId === stored.pairing.keyId),
          connection: stored.connection,
          tunnel: { status: tunnelStatus, ...(tunnelError ? { error: tunnelError } : {}) },
        },
      });
    });
  });

  const trustActor = (request: { nodeAgentAuthKeyId?: string }) => {
    const keyId = request.nodeAgentAuthKeyId;
    if (!keyId) return { type: "local" as const, id: "local-node-agent-admin" };
    const authority = identity.resolveControlPlaneAuthority(keyId);
    if (!authority) {
      throw Object.assign(new Error("The authenticated Control Plane identity could not be resolved."), {
        statusCode: 403,
        code: "NODE_AGENT_CONTROL_PLANE_IDENTITY_UNRESOLVED",
      });
    }
    return {
      type: "control-plane" as const,
      id: authority.controlPlaneId,
      connectionType: authority.connectionType,
    };
  };

  const trustSnapshot = () => identity.cloudControlPlaneTrustSnapshot();

  app.get("/api/node-agent/control-plane-trust", async () => ({ data: trustSnapshot() }));

  app.post("/api/node-agent/control-plane-trust/requests/:requestId/decision", async (request) => {
    const { requestId } = z.object({ requestId: StoredIdSchema }).strict().parse(request.params);
    const input = NodeAgentControlPlaneTrustDecisionSchema.parse(request.body);
    const actor = trustActor(request);
    const decision = identity.decideCloudControlPlaneTrust({
      action: input.action,
      requestId,
      expectedFingerprint: input.expectedFingerprint,
      expectedRevision: input.expectedRevision,
      actor,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.action === "approve" && input.retainPreviousKey !== undefined ? { retainPreviousKey: input.retainPreviousKey } : {}),
    });
    options.onTrustChanged?.({ decision });
    return { data: trustSnapshot() };
  });

  app.post("/api/node-agent/control-plane-trust/requests/:requestId/retry", async (request) => {
    const { requestId } = z.object({ requestId: StoredIdSchema }).strict().parse(request.params);
    NodeAgentControlPlaneTrustRetrySchema.parse(request.body ?? {});
    const retried = identity.retryCloudControlPlaneTrustRequest(requestId, trustActor(request));
    options.onTrustChanged?.({ retried });
    return { data: trustSnapshot() };
  });

  app.post("/api/node-agent/control-plane-trust/pins/:pinId/revoke", async (request) => {
    const { pinId } = z.object({ pinId: StoredIdSchema }).strict().parse(request.params);
    const input = NodeAgentControlPlaneTrustRevokeSchema.parse(request.body);
    const revokedPin = identity.revokeCloudControlPlaneTrustPin({
      pinId,
      expectedFingerprint: input.expectedFingerprint,
      expectedRevision: input.expectedRevision,
      actor: trustActor(request),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    options.onTrustChanged?.({ revokedPin });
    return { data: trustSnapshot() };
  });
}
