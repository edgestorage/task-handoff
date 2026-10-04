import { z } from "zod";
import { InstanceDeleteInputSchema, InstanceDeleteResultSchema } from "@task-handoff/protocol/control-plane";
import { ApprovalSnapshotSchema, ApprovalWaitSchema } from "@task-handoff/protocol/operation-approvals";
import { DeleteNodeResultSchema } from "./node-admin.ts";
import type { ControlPlaneClientTransport } from "./transport.ts";

const data = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();
const support = z.object({ supported: z.literal(true) });

export function createOperationApprovalsApi(transport: ControlPlaneClientTransport) {
  return {
    async support() {
      return (await transport.request("/api/operation-approvals/support", data(support))).data;
    },
    async status(id: string) {
      return (await transport.request(`/api/operation-approvals/${encodeURIComponent(id)}/status`, data(ApprovalWaitSchema))).data;
    },
    async cancel(id: string) {
      return (await transport.request(`/api/operation-approvals/${encodeURIComponent(id)}`, data(z.object({ cancelled: z.boolean() })), { method: "DELETE" })).data;
    },
    async snapshot() {
      return (await transport.request("/api/operation-approvals", data(ApprovalSnapshotSchema))).data;
    },
    async decide(id: string, decision: "approve" | "deny") {
      return (await transport.request(`/api/operation-approvals/${encodeURIComponent(id)}/decision`, data(z.object({ id: z.string(), status: z.enum(["approved", "denied"]) })), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }),
      })).data;
    },
    async deleteInstance(id: string, input: z.infer<typeof InstanceDeleteInputSchema>) {
      return (await transport.request(`/api/controlled-instances/${encodeURIComponent(id)}`, data(InstanceDeleteResultSchema), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(InstanceDeleteInputSchema.parse(input)),
      })).data;
    },
    async removeNode(id: string, force: boolean) {
      return (await transport.request(`/api/nodes/${encodeURIComponent(id)}${force ? "?force=true" : ""}`, data(DeleteNodeResultSchema), {
        method: "DELETE",
      })).data;
    },
  };
}
