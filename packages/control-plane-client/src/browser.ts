import { z } from "zod";
import { BrowserAccessHandshakeSchema } from "@task-handoff/protocol/browser-access";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).strict();

export function createControlPlaneBrowserApi(transport: ControlPlaneClientTransport) {
  return {
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
