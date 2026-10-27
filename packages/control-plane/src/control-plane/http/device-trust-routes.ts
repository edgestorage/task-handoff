import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CloudDeviceTrustDecisionSchema,
  CloudDeviceTrustRevokeSchema,
  CloudDeviceTrustSnapshotSchema,
  type CloudDeviceTrustRoleOption,
} from "@task-handoff/protocol/device-trust";
import type { CloudDeviceTrustActor, CloudDeviceTrustService } from "../device-trust/service.ts";

type DeviceTrustRouteContext = {
  service: CloudDeviceTrustService;
  actor(request: FastifyRequest): CloudDeviceTrustActor;
  bindingId(request: FastifyRequest): string | undefined;
  roles(): Promise<CloudDeviceTrustRoleOption[]>;
};

export function registerDeviceTrustRoutes(app: FastifyInstance, context: DeviceTrustRouteContext) {
  const snapshot = async (request: FastifyRequest) => CloudDeviceTrustSnapshotSchema.parse(
    await context.service.snapshot(context.bindingId(request), await context.roles()),
  );

  app.get("/api/device-trust", async (request) => {
    await context.service.assertTrustedAdmin(context.actor(request));
    return { data: await snapshot(request) };
  });

  app.post("/api/device-trust/requests/:requestId/decision", async (request) => {
    const params = z.object({ requestId: z.string().trim().min(1).max(160) }).parse(request.params);
    const decision = CloudDeviceTrustDecisionSchema.parse(request.body);
    const actor = context.actor(request);
    if (decision.decision === "approve") {
      await context.service.approve({
        requestId: params.requestId,
        expectedFingerprint: decision.expectedFingerprint,
        expectedRevision: decision.expectedRevision,
        roleId: decision.roleId,
        actor,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
    } else {
      await context.service.reject({
        requestId: params.requestId,
        expectedFingerprint: decision.expectedFingerprint,
        expectedRevision: decision.expectedRevision,
        actor,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
    }
    return { data: await snapshot(request) };
  });

  app.post("/api/device-trust/pins/:pinId/revoke", async (request) => {
    const params = z.object({ pinId: z.string().trim().min(1).max(160) }).parse(request.params);
    const input = CloudDeviceTrustRevokeSchema.parse(request.body);
    await context.service.revokePin({
      pinId: params.pinId,
      expectedRevision: input.expectedRevision,
      actor: context.actor(request),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return { data: await snapshot(request) };
  });
}
