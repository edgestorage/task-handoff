import { z } from "zod";
import {
  CONTROL_PLANE_CAPABILITY_HEADER,
  CONTROL_PLANE_IDENTITY_EXTENSIONS_CAPABILITY,
  ControlPlanePublicIdentityDocumentSchema,
  supportsControlPlaneRemoteDesktopRelay,
} from "@task-handoff/protocol/control-plane-access";
import {
  DesktopCreatedSchema,
  DesktopFallbackSessionSchema,
  DesktopSessionSnapshotSchema,
  DesktopSignalTicketSchema,
  DesktopSourcesSchema,
  type DesktopCaptureSelection,
  type DesktopCreated,
  type DesktopFallbackSession,
  type DesktopSessionSnapshot,
  type DesktopSignalTicket,
  type DesktopSource,
} from "@task-handoff/protocol/remote-desktop";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).strict();
const RemoteDesktopSourcesResponseSchema = z.object({ sources: DesktopSourcesSchema }).strict();
const RemoteDesktopSettingsSchema = z.object({ enabled: z.boolean() }).strip();
const RemoteDesktopStoppedSchema = z.object({ stopped: z.boolean() }).strip();

export type RemoteDesktopSource = DesktopSource;
export type RemoteDesktopCreated = DesktopCreated;
export type RemoteDesktopFallback = DesktopFallbackSession;
export type RemoteDesktopSnapshot = DesktopSessionSnapshot;
export type RemoteDesktopSignalTicket = DesktopSignalTicket;
export type RemoteDesktopSettings = z.infer<typeof RemoteDesktopSettingsSchema>;

/** Same capability probe as the browser byte-channel, scoped to the desktop
 * domain so an older Control Plane never receives the additive channel frame. */
export async function probeControlPlaneRemoteDesktopRelay(transport: ControlPlaneClientTransport, fingerprint: string) {
  const document = await transport.request("/api/control-plane/identity", ControlPlanePublicIdentityDocumentSchema, {
    headers: { [CONTROL_PLANE_CAPABILITY_HEADER]: CONTROL_PLANE_IDENTITY_EXTENSIONS_CAPABILITY },
  });
  return document.data.payload.publicKey.fingerprint === fingerprint
    && supportsControlPlaneRemoteDesktopRelay(document.data.payload.capabilities);
}

/** One authenticated client for the existing browser/component remote desktop
 * routes. The mobile and web clients must not grow a second endpoint family. */
export function createControlPlaneRemoteDesktopApi(transport: ControlPlaneClientTransport) {
  const base = (instanceId: string) => `/api/controlled-instances/${encodeURIComponent(instanceId)}`;
  const session = (instanceId: string, sessionId: string) => `${base(instanceId)}/remote-desktop-sessions/${encodeURIComponent(sessionId)}`;
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  return {
    sources(instanceId: string, signal?: AbortSignal): Promise<{ sources: RemoteDesktopSource[] }> {
      return requestData(`${base(instanceId)}/remote-desktop/sources`, RemoteDesktopSourcesResponseSchema, { signal });
    },
    createSession(instanceId: string, selection: DesktopCaptureSelection, requestId = remoteDesktopRequestId()) {
      return requestData(
        `${base(instanceId)}/remote-desktop-sessions`,
        DesktopCreatedSchema,
        jsonPost({ requestId, selection }),
      );
    },
    takeoverSession(instanceId: string, sessionId: string, selection: DesktopCaptureSelection, requestId = remoteDesktopRequestId()) {
      return requestData(
        `${session(instanceId, sessionId)}/takeover`,
        DesktopCreatedSchema,
        jsonPost({ requestId, selection }),
      );
    },
    resumeSignal(instanceId: string, sessionId: string, requestId = remoteDesktopRequestId()) {
      return requestData(
        `${session(instanceId, sessionId)}/signal`,
        DesktopSignalTicketSchema,
        jsonPost({ requestId }),
      );
    },
    snapshot(instanceId: string, sessionId: string, signal?: AbortSignal) {
      return requestData(session(instanceId, sessionId), DesktopSessionSnapshotSchema, { signal });
    },
    stop(instanceId: string, sessionId: string, requestId = remoteDesktopRequestId()) {
      return requestData(
        session(instanceId, sessionId),
        RemoteDesktopStoppedSchema,
        { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId }) },
      );
    },
    forceStop(instanceId: string, sessionId: string, requestId = remoteDesktopRequestId()) {
      return requestData(
        `${session(instanceId, sessionId)}/force-stop`,
        RemoteDesktopStoppedSchema,
        jsonPost({ requestId }),
      );
    },
    fallback(
      instanceId: string,
      sessionId: string,
      reason: "ice-failed" | "recovery-timeout",
      diagnosticCode?: string,
      requestId = remoteDesktopRequestId(),
    ) {
      return requestData(
        `${session(instanceId, sessionId)}/fallback`,
        DesktopFallbackSessionSchema,
        jsonPost({ requestId, reason, ...(diagnosticCode ? { diagnosticCode } : {}) }),
      );
    },
    settings(instanceId: string, signal?: AbortSignal) {
      return requestData(`${base(instanceId)}/remote-desktop/settings`, RemoteDesktopSettingsSchema, { signal });
    },
    updateSettings(instanceId: string, enabled: boolean) {
      return requestData(
        `${base(instanceId)}/remote-desktop/settings`,
        RemoteDesktopSettingsSchema,
        { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) },
      );
    },
  };
}

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function remoteDesktopRequestId() {
  const crypto = globalThis.crypto as Crypto | undefined;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `rd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
