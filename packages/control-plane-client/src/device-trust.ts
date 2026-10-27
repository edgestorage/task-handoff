import { z } from "zod";
import {
  CloudDeviceTrustDecisionSchema,
  CloudDeviceTrustRevokeSchema,
  CloudDeviceTrustSnapshotSchema,
  type CloudDeviceTrustDecision,
  type CloudDeviceTrustRevoke,
} from "@task-handoff/protocol/device-trust";
import { jsonRequest } from "./json-request.ts";
import type { ControlPlaneClientTransport } from "./transport.ts";

const data = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();

export function createControlPlaneDeviceTrustApi(transport: ControlPlaneClientTransport) {
  return {
    async snapshot() {
      return (await transport.request("/api/device-trust", data(CloudDeviceTrustSnapshotSchema))).data;
    },
    async decide(requestId: string, input: CloudDeviceTrustDecision) {
      return (await transport.request(
        `/api/device-trust/requests/${encodeURIComponent(requestId)}/decision`,
        data(CloudDeviceTrustSnapshotSchema),
        jsonRequest("POST", CloudDeviceTrustDecisionSchema.parse(input)),
      )).data;
    },
    async revoke(pinId: string, input: CloudDeviceTrustRevoke) {
      return (await transport.request(
        `/api/device-trust/pins/${encodeURIComponent(pinId)}/revoke`,
        data(CloudDeviceTrustSnapshotSchema),
        jsonRequest("POST", CloudDeviceTrustRevokeSchema.parse(input)),
      )).data;
    },
  };
}
