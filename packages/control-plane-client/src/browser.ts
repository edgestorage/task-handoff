import { ControlPlanePublicIdentityDocumentSchema, CONTROL_PLANE_CAPABILITY_HEADER, CONTROL_PLANE_IDENTITY_EXTENSIONS_CAPABILITY, supportsControlPlaneBrowserChannel } from "@task-handoff/protocol/control-plane-access";
import type { BrowserChannelHandlers } from "@task-handoff/protocol/relay-browser-channel";
import { z } from "zod";
import { BrowserAccessHandshakeSchema } from "@task-handoff/protocol/browser-access";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).strict();

export function createControlPlaneBrowserApi(transport: ControlPlaneClientTransport) {
  return {
    supportsChannel: () => transport.supportsBrowserChannel?.() ?? Promise.resolve(false),
    async openChannel(instanceId: string, handlers: BrowserChannelHandlers, signal?: AbortSignal) {
      if (!transport.openBrowserChannel) throw Object.assign(new Error("Browser channel is unavailable."), { code: "TRANSPORT_BROWSER_CHANNEL_UNAVAILABLE" });
      return transport.openBrowserChannel(instanceId, handlers, signal);
    },
    async access(instanceId: string) {
      const response = await transport.request(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/browser-access`,
        DataSchema(BrowserAccessHandshakeSchema),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      return response.data;
    },
  };
}

/** Query the single CP capability document over the already authenticated transport. */
export async function probeControlPlaneBrowserChannel(transport: ControlPlaneClientTransport, fingerprint: string) {
  const document = await transport.request("/api/control-plane/identity", ControlPlanePublicIdentityDocumentSchema, {
    headers: { [CONTROL_PLANE_CAPABILITY_HEADER]: CONTROL_PLANE_IDENTITY_EXTENSIONS_CAPABILITY },
  });
  return document.data.payload.publicKey.fingerprint === fingerprint
    && supportsControlPlaneBrowserChannel(document.data.payload.capabilities);
}
